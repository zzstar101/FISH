#!/usr/bin/env bun
/**
 * 按「这次改了哪些文件」算出 CI 该跑哪些领域（Issue #307）。
 *
 * CI 里唯一的输入是 `git diff` 的文件名列表，输出是给 `$GITHUB_OUTPUT` 用的 `key=value` 行；
 * 判断逻辑（`computeFlags`）是纯函数，另有 `scripts/ci-changes.test.ts` 覆盖。
 *
 * 用法：
 *   bun scripts/ci-changes.ts --all                      # 全量（push 到 main / 手动触发）
 *   bun scripts/ci-changes.ts --base origin/main --merge-base
 *   bun scripts/ci-changes.ts --files "apps/api/src/app.ts docs/a.md"
 *   bun scripts/ci-changes.ts --base HEAD~1 --json       # 给人看
 *
 * 保守原则：**认不出来的路径一律按全量处理** —— 漏跑比多跑危险得多。
 */

export const AREAS = [
  'api',
  'worker',
  'web_pc',
  'miniapp',
  'db',
  'contracts',
  'shared',
  'ui',
] as const

export type Area = (typeof AREAS)[number]

export interface Flags {
  /** 全量：CI 自身 / 构建基座 / 基础设施 / 认不出的路径 / 手动触发 / push 到 main */
  full: boolean
  /** 需要装依赖并跑 lint + typecheck */
  static: boolean
  /** 需要 Postgres（其中 apps/api 还需要 MinIO）的测试：apps/api、apps/worker、packages/db */
  dbTests: boolean
  /** 不需要任何服务的单测：apps/web-pc、apps/miniapp、packages/{contracts,shared,ui}、scripts */
  unitTests: boolean
  /** `build:web-pc` + PC preview smoke */
  webPc: boolean
  /** `core:smoke`（真实 API + Worker + Postgres + MinIO 的主链冒烟） */
  smoke: boolean
  areas: Record<Area, boolean>
}

/** 路径前缀 → 领域。 */
const AREA_OF_PREFIX: ReadonlyArray<readonly [string, Area]> = [
  ['apps/api/', 'api'],
  ['apps/worker/', 'worker'],
  ['apps/web-pc/', 'web_pc'],
  ['apps/miniapp/', 'miniapp'],
  ['packages/db/', 'db'],
  ['packages/contracts/', 'contracts'],
  ['packages/shared/', 'shared'],
  ['packages/ui/', 'ui'],
]

/** 一改就全量：CI 自身、开发脚本、基础设施（MinIO 策略等 CI 与运行时都依赖）。 */
const FULL_PREFIXES: readonly string[] = ['.github/workflows/', 'scripts/', 'infra/']

/** 一改就全量：根级构建基座与依赖清单（工作区内的同名文件由上面的前缀覆盖）。 */
const FULL_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'bun.lock',
  'biome.json',
  'tsconfig.json',
  'docker-compose.yml',
  'bunfig.toml',
  '.env.example',
])

/** 改了也不会改变任何构建/测试结果的路径（文档、许可证、编辑器配置）。 */
function isInert(file: string): boolean {
  if (file.endsWith('.md')) return true
  if (file.startsWith('docs/')) return true
  // 非 workflow 的 .github 文件（PR 模板、CODEOWNERS 等）；workflows 在上面已按全量拦掉。
  if (file.startsWith('.github/')) return true
  return file === 'LICENSE' || file === '.gitignore' || file === '.editorconfig'
}

/** 传递闭包：共享包改动 → 依赖它的 app 一起算受影响。 */
function closeOverDependencies(hit: Set<Area>): void {
  if (hit.has('shared') || hit.has('contracts') || hit.has('ui')) {
    for (const area of ['api', 'worker', 'web_pc', 'miniapp'] as const) hit.add(area)
  }
  if (hit.has('db')) {
    // 数据库包只被服务端消费；web / miniapp 不直接依赖它。
    hit.add('api')
    hit.add('worker')
  }
}

export function computeFlags(files: readonly string[], options: { full?: boolean } = {}): Flags {
  let full = options.full === true
  const hit = new Set<Area>()

  for (const raw of files) {
    const file = raw.trim().replace(/^\.\//, '')
    if (file === '') continue

    if (FULL_PREFIXES.some((prefix) => file.startsWith(prefix)) || FULL_FILES.has(file)) {
      full = true
      continue
    }
    if (isInert(file)) continue

    const area = AREA_OF_PREFIX.find(([prefix]) => file.startsWith(prefix))?.[1]
    if (area === undefined) {
      full = true
      continue
    }
    hit.add(area)
  }

  if (full) for (const area of AREAS) hit.add(area)
  closeOverDependencies(hit)

  const areas = Object.fromEntries(AREAS.map((area) => [area, hit.has(area)])) as Record<
    Area,
    boolean
  >

  return {
    full,
    static: full || hit.size > 0,
    dbTests: areas.api || areas.worker || areas.db,
    unitTests: areas.web_pc || areas.miniapp || areas.contracts || areas.shared || areas.ui,
    webPc: areas.web_pc,
    smoke: areas.api || areas.worker || areas.db || areas.contracts || areas.shared,
    areas,
  }
}

/** 输出给 `$GITHUB_OUTPUT` 的 `key=value` 行（顺序稳定，便于比对）。 */
export function toGitHubOutputs(flags: Flags): string {
  const rows = new Map<string, boolean>([
    ['full', flags.full],
    ['static', flags.static],
    ['db_tests', flags.dbTests],
    ['unit_tests', flags.unitTests],
    ['web_pc', flags.webPc],
    ['smoke', flags.smoke],
    ...AREAS.map((area) => [area, flags.areas[area]] as const),
  ])
  return [...rows].map(([key, value]) => `${key}=${value}`).join('\n')
}

interface CliOptions {
  all: boolean
  json: boolean
  base?: string
  head: string
  mergeBase: boolean
  files?: string[]
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { all: false, json: false, head: 'HEAD', mergeBase: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--all':
        options.all = true
        break
      case '--json':
        options.json = true
        break
      case '--merge-base':
        options.mergeBase = true
        break
      case '--base': {
        i += 1
        options.base = argv[i]
        break
      }
      case '--head': {
        i += 1
        options.head = argv[i] ?? 'HEAD'
        break
      }
      case '--files': {
        i += 1
        options.files = (argv[i] ?? '').split(/\s+/).filter((file) => file !== '')
        break
      }
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }

  return options
}

function changedFiles(options: CliOptions): string[] {
  if (options.files !== undefined) return options.files
  if (options.base === undefined) return []

  // `--no-renames`：重命名会显示成「删一个 + 加一个」，两边都算改动，比猜重命名更保守。
  const spec = options.mergeBase
    ? [`${options.base}...${options.head}`]
    : [options.base, options.head]
  const result = Bun.spawnSync(['git', 'diff', '--name-only', '--no-renames', ...spec], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`git diff 失败：${result.stderr.toString().trim()}`)
  }
  return result.stdout
    .toString()
    .split('\n')
    .filter((line) => line !== '')
}

function main(argv: readonly string[]): void {
  const options = parseArgs(argv)
  const hasScope = options.base !== undefined || options.files !== undefined
  const files = changedFiles(options)
  // 既没给范围也没给 --all 时按全量：宁可多跑，不要静默什么都不跑。
  const flags = computeFlags(files, { full: options.all || !hasScope })

  console.error(
    `[ci-changes] 改动 ${files.length} 个文件；full=${flags.full} static=${flags.static} ` +
      `db_tests=${flags.dbTests} unit_tests=${flags.unitTests} web_pc=${flags.webPc} smoke=${flags.smoke}`,
  )
  if (files.length > 0 && files.length <= 50) {
    for (const file of files) console.error(`[ci-changes]   ${file}`)
  }

  if (options.json) {
    console.log(JSON.stringify({ changedFiles: files.length, ...flags }, null, 2))
    return
  }
  console.log(toGitHubOutputs(flags))
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[ci-changes] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
