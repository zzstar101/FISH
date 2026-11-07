import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
/** 语法错误的 JSON：无论 linter 规则怎么配，biome 都会报 `parse`。 */
const BROKEN_JSON = '{ "broken": '

/**
 * 仓库真实 `biome.json` 的 `files.includes`。`scripts/lint.ts` 把「这个文件适不适用」交给
 * biome 判断，所以这串排除一旦命中**已跟踪**文件，该文件就被静默跳过 —— 用例直接读真配置，
 * 防止 copy 2.ts、.robobun/local.ts、project.private.config.json 这三类命名排除回流。
 */
const REPO_INCLUDES: string[] = (() => {
  const parsed = JSON.parse(readFileSync(join(import.meta.dir, '..', 'biome.json'), 'utf-8')) as {
    files?: { includes?: string[] }
  }
  const includes = parsed.files?.includes
  if (!Array.isArray(includes)) throw new Error('仓库 biome.json 缺少 files.includes')
  return includes
})()

/** 仓库真实的文件选择（`files.includes`）+ 一条确定性 error 规则，其余细节关掉。 */
const REPO_SELECTION_CONFIG = JSON.stringify({
  formatter: { enabled: false },
  files: { includes: REPO_INCLUDES },
  linter: { rules: { preset: 'none', suspicious: { noDoubleEquals: 'error' } } },
})

/** 按仓库当前口径打开 vcs ignore 读取：验证本地 ignore 文件不能裁掉已跟踪文件。 */
const VCS_IGNORE_CONFIG = JSON.stringify({
  vcs: { enabled: true, clientKind: 'git', useIgnoreFile: true },
  formatter: { enabled: false },
  linter: { rules: { preset: 'none', suspicious: { noDoubleEquals: 'error' } } },
})

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
function makeRepo(files: Record<string, string>, config: string = BIOME_CONFIG): string {
  const cwd = mkdtempSync(join(tmpdir(), 'fish-lint-'))
  created.push(cwd)
  git(cwd, ['init', '-q'])
  write(cwd, { 'biome.json': config, ...files })
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

  test('仓库 files.includes 不会吞掉已跟踪的合法文件', () => {
    const cwd = makeRepo(
      {
        'copy 2.ts': BROKEN,
        '.robobun/local.ts': BROKEN,
        'project.private.config.json': BROKEN_JSON,
      },
      REPO_SELECTION_CONFIG,
    )

    const result = runLint({ cwd })

    expect(result.output).toContain('copy 2.ts')
    expect(result.output).toContain('.robobun/local.ts')
    expect(result.output).toContain('project.private.config.json')
    expect(result.exitCode).not.toBe(0)
  })

  test('只存在于本地的 .git/info/exclude 不能排除已跟踪文件', () => {
    const cwd = makeRepo({ '.gitignore': 'node_modules\n', 'bad.ts': BROKEN }, VCS_IGNORE_CONFIG)
    writeFileSync(join(cwd, '.git/info/exclude'), 'bad.ts\n')

    const result = runLint({ cwd })

    expect(result.output).toContain('bad.ts')
    expect(result.exitCode).not.toBe(0)
  })

  test('未跟踪的嵌套 .gitignore 不能排除已跟踪文件', () => {
    const cwd = makeRepo(
      { '.gitignore': 'node_modules\n', 'src/ok.ts': CLEAN, 'src/bad.ts': BROKEN },
      VCS_IGNORE_CONFIG,
    )
    // 本地新建、未进索引、CI 上不存在的垃圾 ignore。
    write(cwd, { 'src/.gitignore': 'bad.ts\n' })

    const result = runLint({ cwd })

    expect(result.output).toContain('src/bad.ts')
    expect(result.exitCode).not.toBe(0)
  })

  test('仓库 .gitignore 命中已跟踪文件时也不能排除它', () => {
    const cwd = makeRepo({ '.gitignore': 'bad.ts\n', 'ok.ts': CLEAN }, VCS_IGNORE_CONFIG)
    // 已跟踪却命中 .gitignore（`git add -f` 才进得去）：`git ls-files` 照样列出它。
    write(cwd, { 'bad.ts': BROKEN })
    git(cwd, ['add', '-f', 'bad.ts'])

    const result = runLint({ cwd })

    expect(result.output).toContain('bad.ts')
    expect(result.exitCode).not.toBe(0)
  })

  test('format 不碰本地 robobun 产物，但强制跟踪后 lint 仍检查', () => {
    const config = JSON.stringify({
      vcs: { enabled: true, clientKind: 'git', useIgnoreFile: true },
      files: { includes: REPO_INCLUDES },
    })
    const cwd = makeRepo(
      { '.gitignore': readFileSync(join(import.meta.dir, '..', '.gitignore'), 'utf-8') },
      config,
    )
    write(cwd, { '.robobun/evidence/bad.json': BROKEN_JSON })
    const result = Bun.spawnSync(
      [join(import.meta.dir, '..', 'node_modules', '.bin', 'biome'), 'format', '--write', '.'],
      { cwd, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(cwd, '.robobun/evidence/bad.json'), 'utf-8')).toBe(BROKEN_JSON)
    git(cwd, ['add', '-f', '.robobun/evidence/bad.json'])
    const lint = runLint({ cwd })
    expect(lint.output).toContain('.robobun/evidence/bad.json')
    expect(lint.exitCode).not.toBe(0)
  })

  test('同名垃圾未跟踪时不影响，git add 之后立刻纳入', () => {
    const cwd = makeRepo({ 'ok.ts': CLEAN }, REPO_SELECTION_CONFIG)
    write(cwd, { 'copy 2.ts': BROKEN })

    expect(runLint({ cwd }).exitCode).toBe(0)

    git(cwd, ['add', 'copy 2.ts'])
    expect(runLint({ cwd }).exitCode).not.toBe(0)
  })
})
