import { describe, expect, test } from 'bun:test'
import { parseArgs } from './rank-eval'

// CLI 的两个承诺必须被测试锁住（设计 §10.1「CLI 参数与输出」）：
// 1. `--fixture` 完全不碰数据库（CI 的 unit-tests 作业没有 DB）；
// 2. 参数错误要报错退出，而不是静默用默认窗口跑出一份"看起来正常"的指标。
const scriptPath = Bun.fileURLToPath(new URL('./rank-eval.ts', import.meta.url))
const repoRoot = Bun.fileURLToPath(new URL('../../../', import.meta.url))

type CliResult = { exitCode: number; stdout: string; stderr: string }

async function runCli(args: readonly string[]): Promise<CliResult> {
  // 故意把 DATABASE_URL 指向不可达地址：fixture 模式若偷偷连库就会失败，
  // 而不是靠"本机恰好有库"蒙混过关（Bun 会自动读仓库 .env，所以必须显式覆盖）。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
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

describe('rank:eval CLI', () => {
  test('--fixture --json：不连库也出结果，形状与 fixture 样本一致', async () => {
    const result = await runCli(['--fixture', '--json'])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain('ECONNREFUSED')

    const parsed = JSON.parse(result.stdout) as {
      mode: string
      retention?: string
      metrics: {
        sample: {
          requests: number
          evaluatedRequests: number
          requestsWithoutPositiveSignal: number
        }
        quality: Array<{ k: number }>
        coverage: { coverage: number }
        channelAccounting: unknown[]
      }
    }
    expect(parsed.mode).toBe('fixture')
    // fixture 模式没有"回放区间"这回事，保留期提示只属于数据库模式。
    expect(parsed.retention).toBeUndefined()
    expect(parsed.metrics.quality.map((row) => row.k)).toEqual([5, 10, 20])
    expect(parsed.metrics.sample).toMatchObject({
      requests: 6,
      evaluatedRequests: 4,
      requestsWithoutPositiveSignal: 1,
    })
    expect(parsed.metrics.coverage.coverage).toBeCloseTo(7 / 8, 12)
    expect(parsed.metrics.channelAccounting).toHaveLength(5)
  })

  test('--fixture 默认输出 Markdown（带分母，不是只印比率）', async () => {
    const result = await runCli(['--fixture'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('### 排序质量')
    expect(result.stdout).toContain('### 覆盖与曝光分布')
    // 质量表带相关集规模：只有 `Recall@K` 时，"1 个请求的 1.0"和"50 个请求的 1.0"看起来一样。
    expect(result.stdout).toContain('| K | 请求数 | Σ|R(r)| | Recall@K | MRR@K | NDCG@K |')
    // 覆盖表每一行的分子/分母都要有数：均值行印 Σ 与样本数，比率行印计数（不能出现 `— | —`）。
    expect(result.stdout).toContain('| 指标 | 值 | 分子 / Σ | 分母 / 样本数 |')
    for (const label of ['类目多样性', '每请求去重类目数', '新鲜商品曝光率', '重复曝光率']) {
      const row = result.stdout.split('\n').find((line) => line.startsWith(`| ${label}`))
      expect(row).toBeDefined()
      const cells = (row ?? '').split('|').map((cell) => cell.trim())
      // ['', 指标, 值, 分子/Σ, 分母/样本数, '']：后两列必须是数，不是 `—`
      // （均值行的 Σ 可以是小数，分母一定是计数）。
      expect(cells[3]).toMatch(/^-?\d+(\.\d+)?$/)
      expect(cells[4]).toMatch(/^\d+$/)
    }
  })

  test('--k 去重并升序，只影响本次评估的 K 档', async () => {
    const result = await runCli(['--fixture', '--k=10,5,5', '--json'])
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as { metrics: { kValues: number[] } }
    expect(parsed.metrics.kValues).toEqual([5, 10])
  })

  test('非法参数报错退出，不静默跑默认窗口', async () => {
    // 这些用例的 DATABASE_URL 都指向不可达地址：一旦参数校验被绕过，报错就会变成连接失败
    // （PostgresError），断言的消息也就对不上——所以它还顺带证明了"校验在连库之前"。
    const cases = [
      { args: ['--window=abc'], message: '窗口格式应为' },
      { args: ['--window=0h'], message: '窗口必须是正数' },
      { args: ['--since=not-a-date'], message: '不是合法 ISO 时间' },
      { args: ['--k=0'], message: '正整数列表' },
      { args: ['--limit-requests=0'], message: '正整数' },
      { args: ['--nope'], message: '未知参数' },
    ]
    for (const item of cases) {
      const result = await runCli(item.args)
      expect(result.exitCode).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain(item.message)
    }
  })

  test('--help 打印用法并退出 0', async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('用法：')
    expect(result.stdout).toContain('--fixture')
  })
})

describe('parseArgs 默认值', () => {
  test('空参数 = 7 天窗 + 默认 K 档 + 非 fixture/非 json', () => {
    expect(parseArgs([])).toEqual({
      fixture: false,
      json: false,
      windowMs: 7 * 86_400_000,
      since: null,
      until: null,
      kValues: [5, 10, 20],
      limitRequests: null,
    })
  })

  test('--since/--until/--limit-requests 覆盖默认窗口', () => {
    const options = parseArgs([
      '--since=2026-01-01T00:00:00Z',
      '--until=2026-01-08T00:00:00Z',
      '--limit-requests=25',
      '--json',
    ])
    expect(options.since?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(options.until?.toISOString()).toBe('2026-01-08T00:00:00.000Z')
    expect(options.limitRequests).toBe(25)
    expect(options.json).toBe(true)
  })
})
