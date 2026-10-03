import { describe, expect, test } from 'bun:test'
import { RECOMMENDATION_CLEANUP_BATCH_SIZE } from '@fish/contracts/recommendation/observability'
import { parseArgs } from './recommendation-cleanup'

// 清理 CLI 的两个承诺（设计 §10.1「CLI 参数与输出」）：
// 1. 参数错误必须报错退出：这里数的是"要删的行"，一个静默跑默认批大小的 CLI 会把
//    `--batch-size=0`（无限批？还是一行？）变成没人知道的行为；
// 2. `--dry-run` 语义只在参数层（真删/试运行的分支都在 `cleanupExpiredRecommendationData` 里），
//    所以参数解析必须原样透传，不能在 CLI 里被"归一化"掉。
//
// 这里**不**连库：连库行为由 `src/jobs/recommendation/cleanup.test.ts` 的集成用例覆盖，
// 而本文件要能在 CI 的 unit-tests 作业（无 DB）里跑。
const scriptPath = Bun.fileURLToPath(new URL('./recommendation-cleanup.ts', import.meta.url))
const repoRoot = Bun.fileURLToPath(new URL('../../../', import.meta.url))

type CliResult = { exitCode: number; stdout: string; stderr: string }

async function runCli(args: readonly string[]): Promise<CliResult> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  // 指向不可达地址：一旦参数校验被绕过，报错会是连接失败而不是参数错误，断言的消息就对不上。
  env.DATABASE_URL = 'postgres://fish:fish@127.0.0.1:1/unreachable'
  const proc = Bun.spawn(['bun', 'run', scriptPath, ...args], {
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode: await proc.exited, stdout, stderr }
}

describe('recommendation:cleanup CLI', () => {
  test('非法参数报错退出，不静默用默认值跑', async () => {
    const cases = [
      { args: ['--batch-size=0'], message: '--batch-size 应为正整数' },
      { args: ['--batch-size=-5'], message: '--batch-size 应为正整数' },
      { args: ['--batch-size=1.5'], message: '--batch-size 应为正整数' },
      { args: ['--batch-size=abc'], message: '--batch-size 应为正整数' },
      { args: ['--nope'], message: '未知参数' },
    ]
    for (const item of cases) {
      const result = await runCli(item.args)
      expect(result.exitCode).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain(item.message)
    }
  })

  test('--help 打印用法并退出 0（不连库）', async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('recommendation:cleanup')
    expect(result.stderr).not.toContain('ECONNREFUSED')
  })

  test('import 这个模块不会执行清理（import.meta.main 守卫）', () => {
    // 反过来验证：如果守卫被删掉，上面 import parseArgs 的那一行就会去连不可达的库并抛错，
    // 整个文件都跑不起来。这里再断言默认值本身就够说明"只有解析逻辑被加载"。
    expect(parseArgs([])).toEqual({
      dryRun: false,
      batchSize: RECOMMENDATION_CLEANUP_BATCH_SIZE,
      json: false,
    })
  })
})

describe('parseArgs', () => {
  test('默认值：真删、契约批大小、非 JSON', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      batchSize: RECOMMENDATION_CLEANUP_BATCH_SIZE,
      json: false,
    })
  })

  test('--once 是显式接受但不改变语义的旗标', () => {
    expect(parseArgs(['--once'])).toEqual({
      dryRun: false,
      batchSize: RECOMMENDATION_CLEANUP_BATCH_SIZE,
      json: false,
    })
  })

  test('--dry-run / --json / --batch-size 各自生效且可组合', () => {
    expect(parseArgs(['--once', '--dry-run', '--json', '--batch-size=7'])).toEqual({
      dryRun: true,
      batchSize: 7,
      json: true,
    })
  })
})
