import { describe, expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * 路由字面量守卫（分包化后新增）。
 *
 * 分包把页面从 `src/pages/<page>/` 挪到 `src/<root>/pages/<page>/`（`root` 见
 * `app.config.ts` 的 `subPackages`），所有写死的 `'/pages/<page>/index'` 都要跟着
 * 带上分包根。漏一处不会编译报错 —— `Taro.navigateTo` 只会在真机上静默跳失败。
 * 这条测试把「代码里出现的每一个页面路由」与「`app.config.ts` 声明的页面清单」
 * 对起来，另外校验声明过的页面在磁盘上真有对应目录。
 *
 * 动态拼接的路由（`` `/pages/${name}/index` ``）不在本测试覆盖范围内 —— 本仓当前
 * 没有这种写法（见本次改动报告）。
 */

const miniappRoot = new URL('..', import.meta.url)
const SCAN_DIRS = ['src', 'preview', 'tests']
const SCAN_EXTS = new Set(['.ts', '.tsx', '.scss', '.mjs', '.js'])

/** 路径分隔符归一成 `/`，方便按目录前缀断言。 */
function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** `lastSig` 落在这些字符之后时，`/` 更可能是正则字面量的开头而不是除号。 */
const REGEX_AFTER_CHAR = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
])
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

/**
 * 标出源码里**不是注释**的字符（`true` = 代码/字符串/正则字面量）。
 *
 * 为什么需要它：注释里大量出现 `` `pages/foo/index.scss` `` 这类**文档引用**，它们
 * 不是路由字面量，不能拿来跟 `app.config.ts` 对账。裸正则会把它们一起抓进来。
 * 因此这里做一个够用的词法扫描：字符串、模板串、正则字面量都当代码跳过，只有
 * `//` 与 `/* *​/` 覆盖的区间标成注释。
 */
function codeMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(true)
  const markComment = (from: number, to: number) => {
    for (let k = from; k < to; k++) mask[k] = false
  }
  let i = 0
  let lastSig = ''
  let word = ''
  const regexAllowed = () => REGEX_AFTER_WORD.has(word) || REGEX_AFTER_CHAR.has(lastSig)
  const n = src.length
  while (i < n) {
    const c = src[i] ?? ''
    const c2 = src[i + 1] ?? ''
    if (c === '/' && c2 === '/') {
      const start = i
      while (i < n && src[i] !== '\n') i++
      markComment(start, i)
      continue
    }
    if (c === '/' && c2 === '*') {
      const start = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      markComment(start, i)
      continue
    }
    if (c === '/' && regexAllowed()) {
      i++
      let inClass = false
      while (i < n) {
        const d = src[i]
        if (d === '\\') {
          i += 2
          continue
        }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) {
          i++
          break
        } else if (d === '\n') break
        i++
      }
      while (i < n && /[a-z]/.test(src[i] ?? '')) i++
      lastSig = '/'
      word = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i++
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === c) {
          i++
          break
        }
        i++
      }
      lastSig = c
      word = ''
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$]/.test(src[i] ?? '')) i++
      word = src.slice(start, i)
      lastSig = src[i - 1] ?? ''
      continue
    }
    word = ''
    lastSig = c
    i++
  }
  return mask
}

/** `'…/pages/<page>/index'`（含模板串里写死的部分）；捕获组 2 是整个字面量内容。 */
const ROUTE_LITERAL = /(['"`])(\/?(?:pkg-[a-z]+\/)?pages\/[a-z0-9-]+\/index)([?#][^'"`\n]*)?\1/g

/** 把字面量内容规整成带前导 `/` 的完整路由（丢掉 query / hash）。 */
function normalizeRoute(literal: string): string {
  const route = literal.split(/[?#]/)[0] ?? literal
  return route.startsWith('/') ? route : `/${route}`
}

/** 从 `app.config.ts` 文本解析出所有完整路由与它们对应的磁盘目录。 */
function declaredRoutes(source: string): { route: string; dir: string }[] {
  const out: { route: string; dir: string }[] = []
  const mainBlock = source.slice(
    source.indexOf('pages: ['),
    source.indexOf(']', source.indexOf('pages: [')),
  )
  for (const m of mainBlock.matchAll(/'([^']+)'/g)) {
    const page = m[1] ?? ''
    out.push({ route: `/${page}`, dir: path.posix.dirname(`src/${page}`) })
  }
  const subAt = source.indexOf('subPackages: [')
  const subBody = source.slice(subAt, source.lastIndexOf(']'))
  for (const block of subBody.matchAll(/root:\s*'([^']+)'[\s\S]*?pages:\s*\[([\s\S]*?)\]/g)) {
    const root = block[1] ?? ''
    for (const page of block[2]?.matchAll(/'([^']+)'/g) ?? []) {
      const p = page[1] ?? ''
      out.push({ route: `/${root}/${p}`, dir: path.posix.dirname(`src/${root}/${p}`) })
    }
  }
  return out
}

const configSource = await Bun.file(new URL('src/app.config.ts', miniappRoot)).text()
const declared = declaredRoutes(configSource)
const declaredRouteSet = new Set(declared.map((d) => d.route))

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) collectFiles(full, acc)
    else if (SCAN_EXTS.has(path.extname(entry))) acc.push(full)
  }
  return acc
}

const scanned: { file: string; line: number; route: string }[] = []
for (const dir of SCAN_DIRS) {
  for (const file of collectFiles(new URL(dir, miniappRoot).pathname)) {
    const rel = toPosix(path.relative(miniappRoot.pathname, file))
    // app.config.ts 是声明源本身，它的页面路径相对分包 root，不能按完整路由对账
    if (rel === 'src/app.config.ts') continue
    const src = await Bun.file(file).text()
    const mask = codeMask(src)
    for (const match of src.matchAll(ROUTE_LITERAL)) {
      const at = match.index ?? 0
      if (mask[at] === false) continue
      const literal = match[2] ?? ''
      scanned.push({
        file: rel,
        line: src.slice(0, at).split('\n').length,
        route: normalizeRoute(literal),
      })
    }
  }
}

describe('路由字面量守卫（分包后）', () => {
  test('解析器没取空：app.config 声明了 37 个页面（5 主包 + 32 分包）', () => {
    expect(declared.length).toBe(37)
  })

  test('扫描器没取空：代码里确实抓到路由字面量', () => {
    expect(scanned.length).toBeGreaterThan(50)
  })

  test('每一个路由字面量都能在 app.config.ts 找到声明', () => {
    const missing = scanned.filter((s) => !declaredRouteSet.has(s.route))
    expect(missing.map((m) => `${m.file}:${m.line} → ${m.route}`)).toEqual([])
  })

  test('app.config.ts 声明的每个页面在磁盘上都有对应目录', () => {
    const missing = declared.filter((d) => {
      const abs = path.join(miniappRoot.pathname, d.dir)
      try {
        return !statSync(abs).isDirectory()
      } catch {
        return true
      }
    })
    expect(missing.map((m) => `${m.route} → ${m.dir}`)).toEqual([])
  })
})
