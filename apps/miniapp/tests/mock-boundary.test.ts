import { describe, expect, test } from 'bun:test'

/**
 * 生产包 fixture 守卫（静态扫描 `src/**`）。
 *
 * ## 为什么需要
 *
 * 演示 fixture（`src/mock/*`）一旦被**任何**运行期模块静态 import，webpack 的
 * scope-hoisting 就会把整片 fixture 合并进生产包 —— 首屏求值可以被 alias 切掉，
 * 包体却瘦不下来。所以「除 mock 层与 `mock-fallback` 外，没有运行期依赖 `@/mock/*`」
 * 必须是一条**测试钉住的不变式**，而不是靠人肉 grep。
 *
 * `import type` / `import { type X }` 会被 TS 擦除，不构成运行期依赖，**不算违规**
 * （`@/mock/types` 是纯类型模块，页面大量这样用）。
 *
 * ## 已知豁免（遗留，非本次范围）
 *
 * `@/mock/{blocks,images,sell}` 还有一批**先于本任务存在**的值导入，分散在其它
 * 页面里（`blocks` 占位骨架、`images` 演示图、`sell` AI 文案候选）。它们不
 * import `catalog`/`account`/`chat`/`discover`，因此不把「ThinkPad X280」那一片
 * fixture 拖进包。这里把它们逐条登记为豁免：**新增**任何 `@/mock/*` 值导入
 * （哪怕落在已豁免的文件里、换了个 specifier）都会失败。清掉这些遗留项后，
 * 直接把对应条目从 `LEGACY_LEAF_MOCK_MODULES` 删掉即可。
 *
 * `@/mock/users` 曾经也在这张表里 —— 详情页只要一个演示用户 id，却把整份
 * `USERS` fixture（昵称、认证态、成交量）拖进了生产包。该常量已搬到
 * `@/lib/demo-user-id`，豁免随之撤销：现在**任何**模块再值导入 `@/mock/users`
 * 都会让本测试失败。
 */

const SRC = new URL('../src/', import.meta.url)

/** 允许运行期依赖 `@/mock/*` 的模块（相对 `src/` 的 POSIX 路径）。 */
const MOCK_LAYER_EXEMPT = new Set([
  // 开发 / 预览的 mock 回退层：它就是 fixture 的消费者。
  'features/mock-fallback.ts',
])

/**
 * 遗留的 fixture **叶子**模块：mock 层之外还有一批**先于本任务存在**的值导入
 * （`blocks` 占位骨架、`images` 演示图、`sell` AI 文案候选）。
 * 它们都不 import `catalog` / `account` / `chat` / `discover`，不会把 `@/mock/api`
 * 那一片拖进生产包，所以这里放行。
 *
 * 按 **specifier** 而不是文件路径豁免：页面会被搬进 `src/pkg-<area>/pages` 下，
 * 文件路径会变、specifier 不会 —— 按路径写会在搬目录时误报。
 * 除这三个之外，任何 `@/mock/*` 的值导入（无论出现在哪个文件）都会失败。
 */
const LEGACY_LEAF_MOCK_MODULES = new Set(['@/mock/blocks', '@/mock/images', '@/mock/sell'])

/** `@/mock/api` 那一片 fixture（整包被 scope-hoisting 合并的根）。 */
const FIXTURE_CLUSTER = [
  '@/mock',
  '@/mock/api',
  '@/mock/catalog',
  '@/mock/account',
  '@/mock/chat',
  '@/mock/discover',
  '@/mock/public-id',
  '@/mock/types',
  '@/mock/wishes',
]

/** 从 import/export 语句的「关键字与 from 之间」的片段判断它是否纯类型。 */
function isTypeOnly(clause: string): boolean {
  const text = clause.trim()
  if (text === 'type' || text.startsWith('type ')) return true
  const brace = text.match(/^\{([\s\S]*)\}$/)
  if (!brace) return false
  const specifiers = brace[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return specifiers.length > 0 && specifiers.every((s) => s === 'type' || s.startsWith('type '))
}

function isMockSpecifier(specifier: string): boolean {
  return specifier === '@/mock' || specifier.startsWith('@/mock/')
}

/** 抽出一个源码文件里所有**运行期**（非 import type）依赖的 `@/mock/*` specifier。 */
function mockValueImports(source: string): string[] {
  const found: string[] = []
  // 只认「行首（允许缩进）就是 import/export」的语句：注释里出现的示例不会被误判。
  const withFrom = /^[ \t]*(?:import|export)\b([\s\S]*?)from[ \t]*['"]([^'"]+)['"]/gm
  const sideEffect = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(withFrom)) {
    if (isMockSpecifier(match[2]) && !isTypeOnly(match[1])) found.push(match[2])
  }
  for (const match of source.matchAll(sideEffect)) {
    if (isMockSpecifier(match[1])) found.push(match[1])
  }
  return found
}

async function scanMockValueImports(): Promise<{ file: string; specifier: string }[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const hits: { file: string; specifier: string }[] = []
  for await (const path of glob.scan({ cwd: SRC.pathname, onlyFiles: true })) {
    if (path.startsWith('mock/') || MOCK_LAYER_EXEMPT.has(path)) continue
    const source = await Bun.file(new URL(path, SRC)).text()
    for (const specifier of mockValueImports(source)) hits.push({ file: path, specifier })
  }
  return hits.sort((a, b) => `${a.file}${a.specifier}`.localeCompare(`${b.file}${b.specifier}`))
}

describe('mock fixture 生产包边界', () => {
  test('mock 层外的 @/mock/* 运行期导入只允许遗留叶子模块', async () => {
    const hits = await scanMockValueImports()
    const unexpected = hits.filter((hit) => !LEGACY_LEAF_MOCK_MODULES.has(hit.specifier))
    expect(unexpected).toEqual([])
  })

  test('没有任何模块运行期 import @/mock/api（整包 fixture 的入口）', async () => {
    const hits = await scanMockValueImports()
    expect(hits.filter((hit) => hit.specifier === '@/mock/api')).toEqual([])
  })

  test('@/mock/api 的转储模块（catalog/account/chat/discover 等）只被 mock 层引用', async () => {
    const hits = await scanMockValueImports()
    expect(hits.filter((hit) => FIXTURE_CLUSTER.includes(hit.specifier))).toEqual([])
  })

  test('没有任何模块运行期 import @/mock/users（整份用户 fixture 靠一个 id 进包）', async () => {
    const hits = await scanMockValueImports()
    expect(hits.filter((hit) => hit.specifier === '@/mock/users')).toEqual([])
  })

  test('生产模块 notifications/decorate.ts 零 fixture 运行期依赖', async () => {
    const source = await Bun.file(new URL('features/notifications/decorate.ts', SRC)).text()
    expect(mockValueImports(source)).toEqual([])
  })

  test('mock-fallback.prod.ts（生产桩）零 fixture 运行期依赖', async () => {
    const source = await Bun.file(new URL('features/mock-fallback.prod.ts', SRC)).text()
    expect(mockValueImports(source)).toEqual([])
  })

  test('扫描器本身认得出 import type 与 inline type（自检，防止守卫变成空转）', () => {
    expect(mockValueImports("import type { A } from '@/mock/types'\n")).toEqual([])
    expect(mockValueImports("import { type A, type B } from '@/mock/types'\n")).toEqual([])
    expect(mockValueImports("import { type A, B } from '@/mock/blocks'\n")).toEqual([
      '@/mock/blocks',
    ])
    expect(mockValueImports("import { A } from '@/mock/blocks'\n")).toEqual(['@/mock/blocks'])
    expect(mockValueImports("import '@/mock/blocks'\n")).toEqual(['@/mock/blocks'])
    expect(mockValueImports("// import { A } from '@/mock/blocks'\n")).toEqual([])
  })
})
