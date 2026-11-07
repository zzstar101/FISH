#!/usr/bin/env bun
/**
 * 本地 `bun run lint` 的门禁：只检查 **git 已跟踪、且 biome 认为适用** 的文件（Issue #611）。
 *
 * 为什么要这层包装：biome 不是 git。`biome check .` 会把工作区里未跟踪的本地垃圾
 * （微信开发者工具生成的 `project.private.config.json`、Finder / `cp` 留下的 `* 2.*` 副本、
 * `.robobun/` 本地配置……）一起检查，于是干净工作树也能 exit 1，而干净检出的 CI `static` 是绿的
 * —— 本地门禁与 CI 结论不一致，会被误判成「main 的门禁坏了」。
 * 靠 `vcs.useIgnoreFile` 或追加 `!` 排除只能列出**已知**垃圾，不等于 tracked-only：
 * 没进 `.gitignore` 的未跟踪文件照样被检查。所以这里改成拿 `git ls-files` 当唯一输入。
 *
 * 行为契约：
 * - 输入只有 `git ls-files`（含暂存区），未跟踪文件永远不传给 biome；
 * - 已在工作区删除的被跟踪文件会被跳过 —— 否则 biome 会报「文件不存在」伪造失败；
 * - 已跟踪文件**不会**被 ignore 文件裁掉：这一次 biome 调用带 `--vcs-use-ignore-file=false`。
 *   否则本机独有的忽略状态会把已跟踪文件静默跳过，而干净的 CI 上又照样检查
 *   （`.git/info/exclude`、未跟踪的嵌套 `.gitignore`、根 `.gitignore` 命中已跟踪文件都能复现）；
 * - 「适用」仍交给 biome 自己判断：`biome.json` 的 `files.includes` 继续生效，
 *   因此 `packages/db/src/migrations`、`routeTree.gen.ts` 这类**仓库声明**的生成文件不会因为
 *   显式传参又跑起来；但那份名单只放生成文件 —— 放「本地垃圾」模式会连已跟踪文件一起静默跳过；
 *   用 `--no-errors-on-unmatched` 兜住「某一批全是排除项」的情况（否则 biome 会以
 *   「No files were processed」exit 1）；
 * - 文件名含空格时按单个 argv 元素传（不拼 shell），路径前缀以 `-` 开头时补 `./` 免得被当成命令行参数；
 * - 参数按字节数分批，避免 `ARG_MAX`；所有批次都会跑完（不因前一批已经失败就漏掉后面的文件），
 *   任一批次失败则整体非零退出。
 *
 * 用法：
 *   bun scripts/lint.ts        # 等价于 `bun run lint`
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'

/** 单次 biome 调用的参数预算（字节）。留足余量：Linux ARG_MAX 通常 2 MiB，macOS 1 MiB。 */
export const DEFAULT_MAX_ARG_BYTES = 100_000

/** 仓库根目录的 biome 可执行文件（相对本脚本所在仓库，而不是被检查的目标仓库）。 */
const SCRIPT_ROOT = join(import.meta.dir, '..')

export interface LintRunOptions {
  /** 从哪个目录定位 git 仓库，默认当前工作目录。 */
  cwd?: string
  /** 单次 biome 调用的参数预算（字节），测试用来验证分批。 */
  maxArgBytes?: number
}

export interface LintRunResult {
  /** biome 的非零退出码会原样传出；全部通过时为 0。 */
  exitCode: number
  /** 实际传给 biome 的批次（仓库相对路径）。 */
  batches: string[][]
  /** biome 的全部输出（stdout + stderr）。 */
  output: string
}

function spawnCapture(command: string[], cwd: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode === null) {
    throw new Error(`无法执行 ${command[0]}`)
  }
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

function gitOutput(cwd: string, args: readonly string[]): string {
  const { exitCode, output } = spawnCapture(['git', ...args], cwd)
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败：${output.trim()}`)
  return output
}

/** 定位 git 仓库根目录（脚本可从任意子目录调用）。 */
function gitRoot(cwd: string): string {
  return gitOutput(cwd, ['rev-parse', '--show-toplevel']).trim()
}

/** 被跟踪文件（仓库相对路径，已按 git 的排序输出；`-z` 避免空格/非 ASCII 的引号转义）。 */
export function trackedFiles(root: string): string[] {
  return gitOutput(root, ['ls-files', '-z'])
    .split('\0')
    .filter((path) => path !== '')
    .filter((path) => {
      // 已被删除（或不是普通文件，如 submodule）的条目不能传给 biome：它会直接报错。
      try {
        return statSync(join(root, path)).isFile()
      } catch {
        return false
      }
    })
}

/** 按参数字节数分批；单个路径超过预算时自己独占一批（不能因此丢文件）。 */
export function chunkPaths(
  paths: readonly string[],
  maxArgBytes: number = DEFAULT_MAX_ARG_BYTES,
): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let bytes = 0

  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1
    if (current.length > 0 && bytes + size > maxArgBytes) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(path)
    bytes += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function biomeBin(root: string): string {
  const local = join(SCRIPT_ROOT, 'node_modules', '.bin', 'biome')
  try {
    if (statSync(local).isFile()) return local
  } catch {
    // 落到 PATH 上的 biome。
  }
  const fromPath = Bun.which('biome', { cwd: root })
  if (fromPath !== null) return fromPath
  throw new Error('找不到 biome 可执行文件，请先 `bun install`')
}

/** 跑一次 lint，返回退出码与批次；CLI 只负责打印与 `process.exit`。 */
export function runLint(options: LintRunOptions = {}): LintRunResult {
  const cwd = options.cwd ?? process.cwd()
  const maxArgBytes = options.maxArgBytes ?? DEFAULT_MAX_ARG_BYTES

  const root = gitRoot(cwd)
  const tracked = trackedFiles(root)
  // 空索引一律当失败：门禁宁可红，也不能在「一个文件都没检查」时静默通过。
  if (tracked.length === 0) {
    throw new Error(`git ls-files 没有列出任何被跟踪文件（仓库根：${root}），拒绝静默通过`)
  }
  const batches = chunkPaths(tracked, maxArgBytes)
  const biome = biomeBin(root)

  let exitCode = 0
  let output = ''
  for (const batch of batches) {
    const args = batch.map((path) => (path.startsWith('-') ? `./${path}` : path))
    const result = spawnCapture(
      [biome, 'check', '--no-errors-on-unmatched', '--vcs-use-ignore-file=false', ...args],
      root,
    )
    output += result.output
    if (result.exitCode !== 0 && exitCode === 0) exitCode = result.exitCode
  }

  return { exitCode, batches, output }
}

function main(argv: readonly string[]): number {
  const unknown = argv.filter((arg) => arg !== '')
  if (unknown.length > 0) {
    console.error(`[lint] 不接受参数：${unknown.join(' ')}（要检查的文件由 git ls-files 决定）`)
    return 1
  }

  try {
    const result = runLint()
    const files = result.batches.flat().length
    if (result.output !== '') process.stderr.write(result.output)
    console.error(`[lint] 检查 ${files} 个被跟踪文件（${result.batches.length} 批）`)
    return result.exitCode
  } catch (error) {
    console.error(`[lint] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
