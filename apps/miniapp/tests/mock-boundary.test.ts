import { describe, expect, test } from 'bun:test'
import path from 'node:path'

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
 * ## 本测试实际覆盖什么（别把话说满）
 *
 * 覆盖三类**值**依赖，且相对路径与 `@/mock/*` 别名一视同仁：
 * ① `import … from`（含多行）/ `export … from`；② 副作用 `import '…'`；
 * ③ `await import('…')` 形式的动态 import。
 * **不覆盖**：`require()`（本仓小程序端不使用）、`jest.mock` 之类的测试期注入、
 * 运行时字符串拼接出来的模块路径。
 *
 * 扫描对象是 `src/**`（含 `tests/`、`preview/` 之外的源码树），**跳过** `src/mock/**`
 * 本身（它就是要消费 fixture 的那一层）与 `features/mock-fallback.ts`。跳过
 * `src/mock/**` 曾留下一个洞：留在生产包里的叶子（`mock/blocks` 等）自己再 import
 * `mock/users`，就会把整份 `USERS` 拖回包里而没人拦 —— 现在由「叶子传递闭包」那条
 * 测试专门守住。
 *
 * ## 仍然留在生产包里的演示数据（已知，非本测试范围）
 *
 * 1. `@/mock/{blocks,images,sell}` 三个**叶子**：被 mock 层之外的调用点值导入
 *    （`blocks` 占位骨架 5 处、`images` 演示图 `pages/sell/index.tsx`、`sell` AI 文案
 *    候选 `features/ai/api.ts`）。它们不触达下面的 fixture 簇，这里逐条登记为豁免；
 *    新增任何 `@/mock/*` 值导入（含相对路径写法）都会失败。清掉遗留项后把对应条目
 *    从 `LEGACY_LEAF_MOCK_MODULES` 删掉即可。
 * 2. **页面自带的演示数据集**（不属于 `src/mock/**`，本守卫管不到）：
 *    `pkg-browse/pages/history/records.ts:481`（含「联想 ThinkPad X280 轻薄本」）、
 *    `pkg-browse/pages/favorites/list.ts`、`features/following/demo.ts` 里的演示用户昵称、
 *    以及 `features/auth/demo.ts` 的 `DEMO_USER`。它们**确实在生产产物里**（实测
 *    `dist/pkg-browse/pages/history/index.js` 有 `ThinkPad X280`，`dist/pkg-browse/` 下
 *    有收藏/关注页的演示昵称）—— 说「演示数据不进生产包」是错的，正确说法是
 *    「`@/mock/api` 那一片 fixture 不进生产包」。
 *
 * `@/mock/users` 曾经也在豁免表里 —— 详情页只要一个演示用户 id，却把整份 `USERS`
 * fixture（昵称、认证态、成交量）拖进了生产包。该常量已搬到 `@/lib/demo-user-id`，
 * 豁免随之撤销。
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
 * 它们不触达下面的 fixture 簇，不会把 `@/mock/api` 那一片拖进生产包，所以这里放行。
 *
 * 按 **specifier** 而不是文件路径豁免：页面会被搬进 `src/pkg-<area>/pages` 下，
 * 文件路径会变、specifier 不会 —— 按路径写会在搬目录时误报。
 * 除这三个之外，任何 `@/mock/*` 的值导入（无论出现在哪个文件）都会失败。
 */
const LEGACY_LEAF_MOCK_MODULES = new Set(['@/mock/blocks', '@/mock/images', '@/mock/sell'])

/**
 * 一旦进包就会把整片 fixture 拖进来的模块（scope-hoisting 的根与它的转储模块）。
 * 两个地方都不许触达：mock 层之外的任何文件，以及上面三个**叶子**的传递闭包。
 */
const FIXTURE_CLUSTER = [
  '@/mock/api',
  '@/mock/catalog',
  '@/mock/account',
  '@/mock/chat',
  '@/mock/discover',
  '@/mock/wishes',
  '@/mock/users',
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

/**
 * 把注释换成空格，字符串原样保留。
 *
 * 扫描必须在**无注释**的文本上做：注释里写 `await import('@/mock/users')` 举例
 * （本仓文档注释习惯带反例）不能被当成真依赖，反过来也不能漏掉真代码。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line'
        out += '  '
        i += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block'
        out += '  '
        i += 2
        continue
      }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      out += char
      i += 1
      continue
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code'
        out += char
      } else out += ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code'
        out += '  '
        i += 2
        continue
      }
      out += char === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    // 字符串内部：转义跳过，遇同类引号回到 code。
    if (char === '\\') {
      out += char + (next ?? '')
      i += 2
      continue
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      state = 'code'
    }
    out += char
    i += 1
  }
  return out
}

/**
 * 把 specifier 归一成 `@/mock/...` 形式的规范 id；不是 mock 依赖就返回 `null`。
 *
 * 相对路径也要认：`features/listing/adapt.ts` 里的 `'../../mock/users'` 与
 * `'@/mock/users'` 是同一个模块，只认别名会漏（这是审查实测出来的洞）。
 *
 * @param fromFile 相对 `src/` 的 POSIX 路径
 */
function resolveMockId(specifier: string, fromFile: string): string | null {
  const bare = specifier.replace(/\.(ts|tsx)$/, '')
  if (bare === '@/mock' || bare.startsWith('@/mock/')) return bare
  if (!specifier.startsWith('.')) return null
  const resolved = path.posix
    .normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    .replace(/\.(ts|tsx)$/, '')
  if (resolved === 'mock' || resolved.startsWith('mock/')) return `@/${resolved}`
  return null
}

/** 抽出一个源码文件里所有**运行期**（非 import type）依赖的 `@/mock/*` 规范 id。 */
function mockValueImports(source: string, fromFile: string): string[] {
  const code = stripComments(source)
  const found: string[] = []
  const push = (specifier: string) => {
    const id = resolveMockId(specifier, fromFile)
    if (id !== null) found.push(id)
  }
  // 只认「行首（允许缩进）就是 import/export」的语句；`[\s\S]*?` 允许跨行到 `from`。
  const withFrom = /^[ \t]*(?:import|export)\b([\s\S]*?)from[ \t]*['"]([^'"]+)['"]/gm
  const sideEffect = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm
  const dynamic = /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g
  for (const match of code.matchAll(withFrom)) {
    if (!isTypeOnly(match[1])) push(match[2])
  }
  for (const match of code.matchAll(sideEffect)) push(match[1])
  for (const match of code.matchAll(dynamic)) push(match[1])
  return found
}

async function readSource(file: string): Promise<string> {
  return Bun.file(new URL(file, SRC)).text()
}

async function scanMockValueImports(): Promise<{ file: string; specifier: string }[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const hits: { file: string; specifier: string }[] = []
  for await (const file of glob.scan({ cwd: SRC.pathname, onlyFiles: true })) {
    if (file.startsWith('mock/') || MOCK_LAYER_EXEMPT.has(file)) continue
    for (const specifier of mockValueImports(await readSource(file), file)) {
      hits.push({ file, specifier })
    }
  }
  return hits.sort((a, b) => `${a.file}${a.specifier}`.localeCompare(`${b.file}${b.specifier}`))
}

/**
 * 从三个遗留叶子出发，沿 `src/mock/**` 内部的运行期依赖做传递闭包。
 *
 * 只看叶子自己的 import 不够：`mock/blocks.ts` 若 import 一个 helper，而 helper
 * 又 import `mock/users`，`USERS` 照样进包。闭包才算「叶子会把什么带进包」。
 */
async function leafFixtureClosure(): Promise<{
  reached: string[]
  offenders: { from: string; to: string }[]
}> {
  const reached = new Set<string>()
  const offenders: { from: string; to: string }[] = []
  const queue = [...LEGACY_LEAF_MOCK_MODULES]
  while (queue.length > 0) {
    const id = queue.pop()
    if (id === undefined || reached.has(id)) continue
    reached.add(id)
    const file = `${id.slice('@/'.length)}.ts`
    const source = await readSource(file)
    for (const next of mockValueImports(source, file)) {
      if (FIXTURE_CLUSTER.includes(next)) offenders.push({ from: id, to: next })
      if (!reached.has(next)) queue.push(next)
    }
  }
  return { reached: [...reached].sort(), offenders }
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

  test('遗留叶子的传递闭包不触达 fixture 簇（含 @/mock/users）', async () => {
    const { reached, offenders } = await leafFixtureClosure()
    // 自检：闭包必须真的走到了东西，否则这条测试是空转。
    expect(reached.length).toBeGreaterThan(1)
    expect(offenders).toEqual([])
  })

  test('生产模块 notifications/decorate.ts 零 fixture 运行期依赖', async () => {
    const source = await readSource('features/notifications/decorate.ts')
    expect(mockValueImports(source, 'features/notifications/decorate.ts')).toEqual([])
  })

  test('mock-fallback.prod.ts（生产桩）零 fixture 运行期依赖', async () => {
    const source = await readSource('features/mock-fallback.prod.ts')
    expect(mockValueImports(source, 'features/mock-fallback.prod.ts')).toEqual([])
  })

  test('扫描器自检：别名 / 相对路径 / 动态 import / 注释 / type-only 都判对', () => {
    const at = 'features/x.ts'
    // type-only 不算运行期依赖
    expect(mockValueImports("import type { A } from '@/mock/types'\n", at)).toEqual([])
    expect(mockValueImports("import { type A, type B } from '@/mock/types'\n", at)).toEqual([])
    // 值导入要认出来
    expect(mockValueImports("import { type A, B } from '@/mock/blocks'\n", at)).toEqual([
      '@/mock/blocks',
    ])
    expect(mockValueImports("import { A } from '@/mock/blocks'\n", at)).toEqual(['@/mock/blocks'])
    expect(mockValueImports("import '@/mock/blocks'\n", at)).toEqual(['@/mock/blocks'])
    // 多行 import
    expect(mockValueImports("import {\n  A,\n} from '@/mock/blocks'\n", at)).toEqual([
      '@/mock/blocks',
    ])
    // 相对路径归一：只认别名会漏掉这一条
    expect(
      mockValueImports("import { A } from '../../mock/users'\n", 'features/listing/adapt.ts'),
    ).toEqual(['@/mock/users'])
    expect(mockValueImports("import { A } from './users'\n", 'mock/chat.ts')).toEqual([
      '@/mock/users',
    ])
    // 动态 import
    expect(mockValueImports("const m = await import('@/mock/users')\n", at)).toEqual([
      '@/mock/users',
    ])
    // 注释里的示例不算
    expect(mockValueImports("// import { A } from '@/mock/blocks'\n", at)).toEqual([])
    expect(mockValueImports("/* await import('@/mock/users') */\n", at)).toEqual([])
    // 非 mock 的依赖不算
    expect(mockValueImports("import { A } from '@/lib/demo-user-id'\n", at)).toEqual([])
    expect(mockValueImports("import { A } from './local'\n", 'features/x.ts')).toEqual([])
  })
})
