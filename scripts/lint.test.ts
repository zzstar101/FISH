import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runLint } from './lint'

// 本文件启动真实 git / Biome 子进程；CI 首次冷启动曾超过默认 5 秒。
// 验证的是文件选择与失败传播，不是进程启动性能；--isolate 将预算限定在本文件。
setDefaultTimeout(30_000)

/** 关掉 formatter、只留一条确定性的 error 规则，避免格式细节干扰断言。 */
const BIOME_CONFIG = `{
  "formatter": { "enabled": false },
  "linter": { "rules": { "preset": "none", "suspicious": { "noDoubleEquals": "error" } } }
}
`

const CLEAN = 'export const ok = 1\n'
/** `==` 命中 `lint/suspicious/noDoubleEquals`（error）。 */
const BROKEN = 'export function eq(a: number, b: number): boolean {\n  return a == b\n}\n'

const created: string[] = []

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

function write(cwd: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(cwd, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function commit(cwd: string): void {
  git(cwd, ['add', '-A'])
  const identity = [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    '-c',
    'commit.gpgsign=false',
  ]
  git(cwd, [...identity, 'commit', '-q', '-m', 'init'])
}

/** 造一个临时 git 仓库：`files` 全部提交（= 被跟踪），返回仓库路径。 */
function makeRepo(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'fish-lint-'))
  created.push(cwd)
  git(cwd, ['init', '-q'])
  write(cwd, { 'biome.json': BIOME_CONFIG, ...files })
  commit(cwd)
  return cwd
}

/** 实际传给 biome 的路径（所有批次摊平）。 */
const checked = (cwd: string, maxArgBytes?: number): string[] =>
  runLint({ cwd, maxArgBytes }).batches.flat()

afterAll(() => {
  for (const cwd of created) rmSync(cwd, { recursive: true, force: true })
})

describe('runLint', () => {
  test('未跟踪文件的 lint 错误不会伪造失败', () => {
    const cwd = makeRepo({ 'ok.ts': CLEAN })
    write(cwd, { 'project.private.config.json': '{ "broken": ', 'copy 2.ts': BROKEN })

    const result = runLint({ cwd })

    expect(checked(cwd)).not.toContain('copy 2.ts')
    expect(result.exitCode).toBe(0)
  })

  test('被跟踪文件的 lint 错误仍然失败', () => {
    const cwd = makeRepo({ 'ok.ts': CLEAN, 'bad.ts': BROKEN })

    const result = runLint({ cwd })

    expect(checked(cwd)).toContain('bad.ts')
    expect(result.output).toContain('bad.ts')
    expect(result.exitCode).not.toBe(0)
  })

  test('对已跟踪文件的未提交改动仍然被检查', () => {
    const cwd = makeRepo({ 'edit.ts': CLEAN })
    write(cwd, { 'edit.ts': BROKEN })

    expect(runLint({ cwd }).exitCode).not.toBe(0)
  })

  test('已在工作区删除的被跟踪文件不会让 biome 报「文件不存在」', () => {
    const cwd = makeRepo({ 'ok.ts': CLEAN, 'gone.ts': CLEAN })
    unlinkSync(join(cwd, 'gone.ts'))

    const result = runLint({ cwd })

    expect(checked(cwd)).not.toContain('gone.ts')
    expect(result.exitCode).toBe(0)
  })

  test('新文件要 git add 之后才进入 lint 输入', () => {
    const cwd = makeRepo({ 'ok.ts': CLEAN })
    write(cwd, { 'staged.ts': BROKEN })

    expect(runLint({ cwd }).exitCode).toBe(0)
    git(cwd, ['add', 'staged.ts'])
    expect(runLint({ cwd }).exitCode).not.toBe(0)
  })

  test('索引里没有任何被跟踪文件时失败，而不是静默通过', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fish-lint-'))
    created.push(cwd)
    git(cwd, ['init', '-q'])

    expect(() => runLint({ cwd })).toThrow()
  })

  test('路径含空格时作为一个参数传递', () => {
    const cwd = makeRepo({ 'spaced file.ts': BROKEN })

    const result = runLint({ cwd })

    expect(checked(cwd)).toContain('spaced file.ts')
    expect(result.output).toContain('spaced file.ts')
    expect(result.exitCode).not.toBe(0)
  })

  test('参数过长时分批传送，且不漏掉任何一个文件', () => {
    const files: Record<string, string> = {}
    for (let i = 1; i <= 8; i += 1) files[`broken-${i}.ts`] = BROKEN
    const cwd = makeRepo(files)

    const result = runLint({ cwd, maxArgBytes: 20 })

    expect(result.batches.length).toBeGreaterThan(1)
    for (const batch of result.batches) {
      const bytes = batch.reduce((sum, path) => sum + Buffer.byteLength(path) + 1, 0)
      if (batch.length > 1) expect(bytes).toBeLessThanOrEqual(20)
    }
    expect(new Set(result.batches.flat())).toEqual(new Set(['biome.json', ...Object.keys(files)]))
    for (const name of Object.keys(files)) expect(result.output).toContain(name)
    expect(result.exitCode).not.toBe(0)
  })

  test('被 biome 配置排除的被跟踪文件不算失败（不是「没有文件被检查」）', () => {
    const cwd = makeRepo({ 'generated/broken.ts': BROKEN })
    write(cwd, {
      'biome.json': `{
  "formatter": { "enabled": false },
  "files": { "includes": ["**", "!generated"] },
  "linter": { "rules": { "preset": "none", "suspicious": { "noDoubleEquals": "error" } } }
}
`,
    })
    commit(cwd)

    // maxArgBytes=1：每个文件单独一批，「全是排除项」的批次也会出现。
    const result = runLint({ cwd, maxArgBytes: 1 })

    expect(result.batches).toEqual([['biome.json'], ['generated/broken.ts']])
    expect(result.exitCode).toBe(0)
  })
})
