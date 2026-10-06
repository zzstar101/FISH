import { describe, expect, test } from 'bun:test'
import path from 'node:path'

/**
 * 生产包 fixture 守卫（静态扫描 `src/**`）。
 *
 * ## 为什么需要
 *
 * 演示 fixture（`src/mock/*`）一旦被**任何**运行期模块静态 import，webpack 的
 * scope-hoisting 就会把整片 fixture 合并进生产包 —— 首屏求值可以被 alias 切掉，
 * 包体却瘦不下来。所以「除 mock 层、`mock-fallback` 与下面登记的**两个遗留叶子**外，
 * 没有运行期依赖 `@/mock/*`」必须是一条**测试钉住的不变式**，而不是靠人肉 grep。
 *
 * `import type` / `import { type X }` 会被 TS 擦除，不构成运行期依赖，**不算违规**
 * （`@/mock/types` 是纯类型模块，页面大量这样用）。类型位置的 `typeof import('…')`
 * 同理 —— 它有专门的跳过分支。
 *
 * ## 本测试实际覆盖什么（别把话说满）
 *
 * 判定在**去注释、且能区分「字符串内容」与「代码」**的文本上做（`lexSource`），
 * 相对路径与 `@/mock/*` 别名一视同仁：
 * ① `import … from` / `export … from`（含多行，**不跨语句**：`export type X = …` 之后
 * 那条 import 不会被前一条吞掉）；② 副作用 `import '…'`（说明符可换行）；③ `import(…)`
 * （单双引号或反引号、可跨行、尾部允许尾逗号或 import attributes）；④ `require('…')`
 * （本仓小程序端未用，顺手拦）。
 * 字符串里写着的 import 源码片段、`.d.ts` 里的类型导入，都不算运行期依赖。
 * `` import(`@/mock/${name}`) `` 与「整条 import 写在模板串 `${…}` 插值里」都**会被拦**：
 * 前者正则不解析 `${}`，把 `` `@/mock/${name}` `` 原文当说明符（非白名单即违规）；后者
 * `lexSource` 把 `${` 之后当代码，`inString` 为 false。别把它们当盲区。
 *
 * **已知盲区（写在这里，别指望它守住）**：
 * - 说明符是**运行期拼出来的**：`import('@/mock/' + name)`、`import(name)`、
 *   `const id = pick(); import(id)` —— 正则只能看见引号字面量；
 * - `jest.mock` / `mock.module` 之类的测试期注入（小程序端不用）。
 *   （这两条独立审查实测确认：`import('@/mock/' + n)` 与 `import(n)` 都漏。）
 *
 * 扫描对象是 `src/**`（`tests/`、`preview/` 不在其下），**跳过** `src/mock/**`
 * 本身（它就是要消费 fixture 的那一层）、`features/mock-fallback.ts` 与 `.d.ts`
 * （`.d.ts` 的 import 只能是类型用途）。跳过 `src/mock/**` 曾留下一个洞：留在生产包里的
 * 叶子（`mock/blocks` 等）自己再 import `mock/users`，就会把整份 `USERS` 拖回包里而
 * 没人拦 —— 现在由「叶子传递闭包」那条测试专门守住（闭包复用同一套判定，所以上面
 * ①②③④ 的盲区对它同样成立）。
 *
 * ## 仍然留在生产包里的演示数据（已知，非本测试范围）
 *
 * 1. `@/mock/{blocks,sell}` 两个**叶子**：被 mock 层之外的调用点值导入
 *    （`blocks` 占位骨架 5 处、`sell` AI 文案候选 `features/ai/api.ts`）。它们不触达
 *    下面的 fixture 簇，这里逐条登记为豁免；新增任何 `@/mock/*` 值导入（含相对路径
 *    写法）都会失败。清掉遗留项后把对应条目从 `LEGACY_LEAF_MOCK_MODULES` 删掉即可。
 *    `@/mock/images` 原来也在表里（`pages/sell/index.tsx` 的角标预览拿它当兜底图），
 *    该调用点改成中性占位后，mock 层之外最后一个消费方消失，条目随之撤销。
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
 * （`blocks` 占位骨架、`sell` AI 文案候选）。
 * 它们不触达下面的 fixture 簇，不会把 `@/mock/api` 那一片拖进生产包，所以这里放行。
 *
 * 按 **specifier** 而不是文件路径豁免：页面会被搬进 `src/pkg-<area>/pages` 下，
 * 文件路径会变、specifier 不会 —— 按路径写会在搬目录时误报。
 * 除这两个之外，任何 `@/mock/*` 的值导入（无论出现在哪个文件）都会失败。
 */
const LEGACY_LEAF_MOCK_MODULES = new Set(['@/mock/blocks', '@/mock/sell'])

/**
 * 一旦进包就会把整片 fixture 拖进来的模块（scope-hoisting 的根与它的转储模块）。
 * 两个地方都不许触达：mock 层之外的任何文件，以及上面两个**叶子**的传递闭包。
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
 * 词法扫描：把注释换成空格，并标出哪些字符是**字符串/模板串内容**。
 *
 * 为什么两件事都要做：
 * - 注释里写 `await import('@/mock/users')` 举例（本仓文档注释习惯带反例）不能被当成
 *   真依赖，反过来也不能漏掉真代码；
 * - 字符串里出现的 import 源码片段（`` const snippet = `import { USERS } from '@/mock/users'` ``）
 *   不是依赖，但字符串**结尾**不能靠「看到引号就跳过」来处理 —— import 的说明符本身
 *   也是字符串，所以这里只**标记**不删除，由调用方按位置判断。
 *
 * 返回的 `code` 与输入等长（逐字符替换），因此下标可以直接当源码偏移用。
 * 模板串里的 `${ … }` 是代码，用栈记回来（`}` 收尾后继续当字符串标记）。
 */
function lexSource(source: string): { code: string; inString: boolean[] } {
  const inString = new Array<boolean>(source.length).fill(false)
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  /** 每个未闭合的模板串插值：`braces` 是插值内部的 `{}` 深度。 */
  const interpolation: { braces: number }[] = []
  const emit = (text: string, marked: boolean) => {
    for (const char of text) {
      out += char
      if (marked) inString[out.length - 1] = true
    }
  }
  while (i < source.length) {
    const char = source[i] ?? ''
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line'
        emit('  ', false)
        i += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block'
        emit('  ', false)
        i += 2
        continue
      }
      if (interpolation.length > 0) {
        const frame = interpolation[interpolation.length - 1]
        if (frame !== undefined) {
          if (char === '{') frame.braces += 1
          else if (char === '}') {
            if (frame.braces === 0) {
              interpolation.pop()
              state = 'template'
              emit(char, true)
              i += 1
              continue
            }
            frame.braces -= 1
          }
        }
      }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      emit(char, false)
      i += 1
      continue
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code'
        emit(char, false)
      } else emit(' ', false)
      i += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code'
        emit('  ', false)
        i += 2
        continue
      }
      emit(char === '\n' ? '\n' : ' ', false)
      i += 1
      continue
    }
    // 字符串 / 模板串内部：转义跳过，遇同类引号回到 code，`${` 进入插值。
    if (char === '\\') {
      emit(char + (next ?? ''), true)
      i += 2
      continue
    }
    if (state === 'template' && char === '$' && next === '{') {
      interpolation.push({ braces: 0 })
      state = 'code'
      emit('${', true)
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
    emit(char, true)
    i += 1
  }
  return { code: out, inString }
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

/** `inString[from, to)` 里有没有字符串内容。 */
function rangeHasString(inString: boolean[], from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (inString[k] === true) return true
  return false
}

/** 抽出一个源码文件里所有**运行期**（非 import type）依赖的 `@/mock/*` 规范 id。 */
function mockValueImports(source: string, fromFile: string): string[] {
  const { code, inString } = lexSource(source)
  const found: string[] = []
  const push = (specifier: string | undefined) => {
    if (specifier === undefined) return
    const id = resolveMockId(specifier, fromFile)
    if (id !== null) found.push(id)
  }
  // 只认「行首（允许缩进）就是 import/export」的语句。两道约束：
  // - 说明符允许跨行（`import {\n  A,\n} from '…'`）；
  // - **不跨语句**：`export type X = …` 这种自己没 `from` 的声明，不能越过下一行的
  //   `import … from` 去认领它的 `from`。旧写法 `([\s\S]*?)` 会这么干，把后一条**真值**
  //   导入整段当成 type-only 丢掉 —— 独立审查在真实文件 `src/mock/sell.ts`（首行就是
  //   `export type PolishCandidate = {`）上实测过这条失效。
  const withFrom =
    /^[ \t]*(?:import|export)\b((?:(?!\n[ \t]*(?:import|export)\b)[\s\S])*?)from[ \t]*['"]([^'"]+)['"]/gm
  // 副作用导入允许说明符换行（`import\n  '@/mock/users'`）；注释已被 `lexSource` 换成空格，
  // 所以注释里的 `import` 不会命中。
  const sideEffect = /^[ \t]*import[ \t\r\n]+['"]([^'"]+)['"]/gm
  // 动态 import：引号或反引号、说明符可跨行；尾部允许 `,`（尾逗号）或 import attributes
  // （`import('…', { with: { type: 'json' } })`）—— 旧写法要求引号后紧跟 `)`，这几种都漏。
  // `require(…)` 顺手一起拦。
  const dynamic = /\b(?:import|require)\s*\(\s*[`'"]([^`'"]+)[`'"]\s*[,)]/g
  for (const match of code.matchAll(withFrom)) {
    const at = match.index ?? 0
    if (inString[at] === true) continue
    // 语句头里混进字符串 ⇒ 这一行其实是字符串/模板串内容
    // （`` const s = `import { USERS } from '@/mock/users'` ``），不是依赖。
    if (rangeHasString(inString, at, at + match[0].indexOf('from'))) continue
    if (!isTypeOnly(match[1] ?? '')) push(match[2])
  }
  for (const match of code.matchAll(sideEffect)) {
    if (inString[match.index ?? 0] !== true) push(match[1])
  }
  for (const match of code.matchAll(dynamic)) {
    const at = match.index ?? 0
    if (inString[at] === true) continue
    // 类型位置：`typeof import('…')` 会被 TS 擦除，不是运行期依赖。
    if (/\btypeof\s*$/.test(code.slice(Math.max(0, at - 16), at))) continue
    push(match[1])
  }
  return found
}

async function readSource(file: string): Promise<string> {
  return Bun.file(new URL(file, SRC)).text()
}

async function scanMockValueImports(): Promise<{ file: string; specifier: string }[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const hits: { file: string; specifier: string }[] = []
  for await (const file of glob.scan({ cwd: SRC.pathname, onlyFiles: true })) {
    // `.d.ts` 里的 import 只能是类型用途（`Bun.Glob('**/*.{ts,tsx}')` 会匹配到它们）。
    if (file.endsWith('.d.ts')) continue
    if (file.startsWith('mock/') || MOCK_LAYER_EXEMPT.has(file)) continue
    for (const specifier of mockValueImports(await readSource(file), file)) {
      hits.push({ file, specifier })
    }
  }
  return hits.sort((a, b) => `${a.file}${a.specifier}`.localeCompare(`${b.file}${b.specifier}`))
}

/**
 * 从两个遗留叶子出发，沿 `src/mock/**` 内部的运行期依赖做传递闭包。
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
    const base = id.slice('@/'.length)
    const ts = `${base}.ts`
    // 叶子既可能是 `.ts` 也可能是 `.tsx`；写死 `.ts` 会在改成组件文件时 ENOENT。
    const file = (await Bun.file(new URL(ts, SRC)).exists()) ? ts : `${base}.tsx`
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
    // 反引号 / 跨行 / require 的写法也要认（审查实测旧正则全漏）
    expect(mockValueImports('const m = await import(`@/mock/users`)\n', at)).toEqual([
      '@/mock/users',
    ])
    expect(mockValueImports("const m = await import(\n  '@/mock/users'\n)\n", at)).toEqual([
      '@/mock/users',
    ])
    expect(mockValueImports("const m = require('@/mock/users')\n", at)).toEqual(['@/mock/users'])
    // 语句边界：自己没 `from` 的 `export type …` 不能越过下一行的真 import
    // （审查在真实文件 `src/mock/sell.ts` 上实测旧正则会把这条真值导入整段丢掉）
    expect(
      mockValueImports("export type Probe = string\nimport { A } from '@/mock/users'\n", at),
    ).toEqual(['@/mock/users'])
    // 类型位置不是运行期依赖
    expect(mockValueImports("type M = typeof import('@/mock/users')\n", at)).toEqual([])
    // 第四轮审查 F8：尾逗号 / import attributes / 换行的副作用导入，旧正则全漏
    expect(mockValueImports("const m = await import('@/mock/users',)\n", at)).toEqual([
      '@/mock/users',
    ])
    expect(
      mockValueImports("const m = await import('@/mock/users', { with: { type: 'json' } })\n", at),
    ).toEqual(['@/mock/users'])
    expect(mockValueImports("const m = require('@/mock/users',)\n", at)).toEqual(['@/mock/users'])
    expect(mockValueImports("import\n  '@/mock/users'\n", at)).toEqual(['@/mock/users'])
    // 审查实测确认为真盲区：说明符运行期拼出来时看不见（写进头部盲区清单，不假装能守住）
    expect(mockValueImports("const m = await import('@/mock/' + name)\n", at)).toEqual([])
    expect(mockValueImports('const m = await import(name)\n', at)).toEqual([])
    // 头部说不算盲区的两条，用用例钉住（免得注释又写反）
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样本要的是字面量 ${...} 文本
    expect(mockValueImports('const m = await import(`@/mock/${name}`)\n', at)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 期望值同样是字面量文本
      '@/mock/${name}',
    ])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样本要的是字面量 ${...} 文本
    expect(mockValueImports("export const s = `${await import('@/mock/users')}`\n", at)).toEqual([
      '@/mock/users',
    ])
    // 字符串里写着的 import 源码片段不是依赖
    expect(
      mockValueImports("export const s = `import { USERS } from '@/mock/users'`\n", at),
    ).toEqual([])
    // 注释里的示例不算
    expect(mockValueImports("// import { A } from '@/mock/blocks'\n", at)).toEqual([])
    expect(mockValueImports("/* await import('@/mock/users') */\n", at)).toEqual([])
    // 非 mock 的依赖不算
    expect(mockValueImports("import { A } from '@/lib/demo-user-id'\n", at)).toEqual([])
    expect(mockValueImports("import { A } from './local'\n", 'features/x.ts')).toEqual([])
  })
})
