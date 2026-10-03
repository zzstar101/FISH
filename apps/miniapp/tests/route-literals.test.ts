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
 * 动态拼接的路由（例：`` `/pkg-trade/pages/${page}/index` ``）单靠上面那条正则是
 * 抓不到的（模板串里有 `${}`）。而分包化最危险的回归形状恰恰在这里：拼接时漏掉
 * 分包 root 会**静默**跳转失败，lint / typecheck / 其它测试全绿。所以动态模板由
 * 下面 `DYNAMIC_ROUTE_TEMPLATES` 白名单钉住（逐字比对 + 落点校验）。
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

/** 模板串里带动态段（`${…}`）的页面路由；捕获组 1 是模板串的全部内容。 */
const DYNAMIC_ROUTE_TEMPLATE = /`([^`]*\/pages\/\$\{[^`]*)`/g

/**
 * 动态拼接路由的**白名单**。
 *
 * `ROUTE_LITERAL` 抓不到 `${}`，所以这类模板串必须逐字点名，并列出它所有可能的落点：
 * 漏掉分包 root（分包后 `/pages/<page>/index` 已不存在）不会有任何编译期报错，只会
 * 让点击静默失效 —— 破坏性实验证明过旧正则对这类改动 0 fail。
 *
 * 新增或改写动态路由必须同步更新本表（否则第一条测试失败）；
 * `candidates` 里每个落点都要在 `app.config.ts` 声明且磁盘上有 `index.tsx`。
 */
const DYNAMIC_ROUTE_TEMPLATES = [
  {
    // `page` 取自同文件的 `record.target === 'LISTING' ? 'report-listing' : 'report-user'`
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这里要的是模板串的**内容**（逐字比对用），不是插值
    literal: '/pkg-trade/pages/${page}/index?reportId=${encodeURIComponent(record.id)}',
    file: 'src/pkg-trade/pages/my-reports/index.tsx',
    candidates: ['/pkg-trade/pages/report-listing/index', '/pkg-trade/pages/report-user/index'],
  },
] as const

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
const dynamicTemplates: { file: string; line: number; literal: string }[] = []
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
    for (const match of src.matchAll(DYNAMIC_ROUTE_TEMPLATE)) {
      const at = match.index ?? 0
      if (mask[at] === false) continue
      dynamicTemplates.push({
        file: rel,
        line: src.slice(0, at).split('\n').length,
        literal: match[1] ?? '',
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

  test('app.config.ts 声明的每个页面在磁盘上都有对应的 index.tsx 与 index.config.ts', () => {
    const missing: string[] = []
    for (const d of declared) {
      for (const name of ['index.tsx', 'index.config.ts']) {
        try {
          if (!statSync(path.join(miniappRoot.pathname, d.dir, name)).isFile()) {
            missing.push(`${d.route} → 缺 ${name}`)
          }
        } catch {
          missing.push(`${d.route} → 缺 ${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('动态拼接路由模板与白名单逐字对应（漏掉分包 root 会在这里失败）', () => {
    const found = dynamicTemplates.map((d) => `${d.file}|${d.literal}`).sort()
    const allowed = DYNAMIC_ROUTE_TEMPLATES.map((d) => `${d.file}|${d.literal}`).sort()
    expect(found).toEqual(allowed)
  })

  test('动态路由模板的每个落点都在 app.config.ts 声明且页面文件存在', () => {
    const problems: string[] = []
    for (const template of DYNAMIC_ROUTE_TEMPLATES) {
      for (const route of template.candidates) {
        if (!declaredRouteSet.has(route)) {
          problems.push(`${template.literal} → ${route} 未在 app.config.ts 声明`)
        }
        const dir = path.join(miniappRoot.pathname, 'src', path.posix.dirname(route.slice(1)))
        for (const name of ['index.tsx', 'index.config.ts']) {
          try {
            if (!statSync(path.join(dir, name)).isFile()) problems.push(`${route} → 缺 ${name}`)
          } catch {
            problems.push(`${route} → 缺 ${name}`)
          }
        }
      }
    }
    expect(problems).toEqual([])
  })
})
