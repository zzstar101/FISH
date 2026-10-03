import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, statSync } from 'node:fs'
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
 * 分包 root 会**静默**跳转失败，lint / typecheck / 其它测试全绿。所以动态模板由下面
 * `DYNAMIC_ROUTE_TEMPLATES` 白名单钉住：比对**静态前缀**（不是逐字相等，避免把
 * `${page}` 改名成 `${pageName}` 这种无意义改动判成失败），并要求每个落点的页面名
 * 作为带引号的字面量真的出现在同文件源码里（避免 candidates 与代码取值脱钩）。
 *
 * 两个方向都要查，缺一个就有盲区（两轮独立审查各实测出过一条）：
 * - 代码 → 声明（`scanned`）：写死的路由必须被声明；
 * - 声明 → 磁盘：声明过的页面必须真存在；
 * - 磁盘 → 声明（`pageDirsOnDisk`）：磁盘上的页面目录不能被漏在 `app.config.ts` 外；
 * - 拼接根（`CONCAT_ROUTE_ROOT`）：`'/pages/' + name` 这种既没 `${}` 也不成整条路由的
 *   写法不能被悄悄放过去。
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

/**
 * 模板串里**路径段**带动态段（`${…}`）的页面路由；捕获组 1 是模板串的全部内容。
 *
 * 两个刻意的取舍：
 * - **不要求** `${` 紧跟 `/pages/`：`` `/pkg-browse/pages/report-${kind}/index` `` 这类把
 *   动态段放在中间的写法同样必须被看见（旧正则会漏）。
 * - **`?` / `#` 之前必须出现 `${`**：`` `/pkg-browse/pages/listing-detail/index?id=${id}` ``
 *   只是 query 动态、路径完全写死，那条由 `ROUTE_LITERAL` 覆盖（它的 `([?#]…)?` 后缀就是
 *   为这种写法准备的）。若这里也收，同一个模板会被两套规则重复判定，白名单会被迫列出
 *   几十条本质上是静态路由的条目。两个扫描器互补，由下面的自检测试钉住这个分工。
 */
const DYNAMIC_ROUTE_TEMPLATE = /`([^`?#]*\/pages\/[^`?#]*\$\{[^`]*)`/g

/**
 * 用字符串拼接出来的路由根（例：`'/pkg-trade/pages/' + name + '/index'`）。
 *
 * 拼接写法既进不了 `ROUTE_LITERAL`（它要求完整的 `…/pages/<page>/index`），也进不了
 * 模板串正则（没有 `${}`）。当前仓库一处都没有，所以白名单为空；一旦有人这样写，
 * 这条守卫会失败并要求显式登记落点。
 */
const CONCAT_ROUTE_ROOT = /['"](\/?(?:pkg-[a-z]+\/)?pages\/)['"]/g

/** 允许以拼接形式出现的路由根（当前为空，见 `CONCAT_ROUTE_ROOT` 说明）。 */
const CONCAT_ROUTE_ROOTS: string[] = []

/**
 * 动态拼接路由的**白名单**。
 *
 * `ROUTE_LITERAL` 抓不到 `${}`，所以这类模板串必须显式点名，并列出它所有可能的落点：
 * 漏掉分包 root（分包后 `/pages/<page>/index` 已不存在）不会有任何编译期报错，只会
 * 让点击静默失效 —— 破坏性实验证明过旧正则对这类改动 0 fail。
 *
 * 比对方式刻意**不是**逐字相等（那样把 `${page}` 改名成 `${pageName}` 也会误报）：
 * - 模板串的**静态前缀**（第一个 `${` 之前的部分）必须与白名单的 `prefix` 一致
 *   ⇒ 漏掉 `/pkg-trade` 前缀会失败；
 * - `candidates` 里每个落点的**页面名**必须作为带引号的字面量出现在同一文件里
 *   ⇒ 把 `'report-listing'` 改成 `'report-listing-TYPO'`（运行时会跳未声明页）会失败。
 */
const DYNAMIC_ROUTE_TEMPLATES = [
  {
    // `page` 取自同文件的 `record.target === 'LISTING' ? 'report-listing' : 'report-user'`
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这里要的是模板串的**内容**（静态前缀比对用），不是插值
    literal: '/pkg-trade/pages/${page}/index?reportId=${encodeURIComponent(record.id)}',
    file: 'src/pkg-trade/pages/my-reports/index.tsx',
    candidates: ['/pkg-trade/pages/report-listing/index', '/pkg-trade/pages/report-user/index'],
  },
] as const

/** 模板串里第一个 `${` 之前的静态前缀。 */
function staticPrefix(literal: string): string {
  const at = literal.indexOf('${')
  return at === -1 ? literal : literal.slice(0, at)
}

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
const concatRoots: { file: string; line: number; root: string }[] = []
const scannedSources = new Map<string, string>()
for (const dir of SCAN_DIRS) {
  for (const file of collectFiles(new URL(dir, miniappRoot).pathname)) {
    const rel = toPosix(path.relative(miniappRoot.pathname, file))
    // app.config.ts 是声明源本身，它的页面路径相对分包 root，不能按完整路由对账
    if (rel === 'src/app.config.ts') continue
    // 本文件是扫描器自己：里面的模板串样本是「喂给正则的输入」，不是真实跳转，
    // 收进来只会让白名单变成自我指涉。字面量扫描仍覆盖本文件（样本路由都是已声明的）。
    const isScannerItself = rel === 'tests/route-literals.test.ts'
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
      if (mask[at] === false || isScannerItself) continue
      dynamicTemplates.push({
        file: rel,
        line: src.slice(0, at).split('\n').length,
        literal: match[1] ?? '',
      })
      scannedSources.set(rel, src)
    }
    for (const match of src.matchAll(CONCAT_ROUTE_ROOT)) {
      const at = match.index ?? 0
      if (mask[at] === false || isScannerItself) continue
      concatRoots.push({
        file: rel,
        line: src.slice(0, at).split('\n').length,
        root: match[1] ?? '',
      })
    }
  }
}

/**
 * 磁盘上的页面目录（含 `index.tsx`）→ 它对应的完整路由。
 *
 * 与「声明 → 磁盘」方向互补：那边保证声明过的页面存在，这边保证磁盘上的页面目录
 * 没有被遗漏在 `app.config.ts` 之外（分包搬迁最容易留下这种孤儿目录）。
 */
function pageDirsOnDisk(): { route: string; file: string }[] {
  const out: { route: string; file: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (!statSync(full).isDirectory()) continue
      if (entry === 'pages') {
        for (const pageName of readdirSync(full)) {
          const pageDir = path.join(full, pageName)
          if (!statSync(pageDir).isDirectory()) continue
          const rel = toPosix(path.relative(miniappRoot.pathname, pageDir))
          if (!existsSync(path.join(pageDir, 'index.tsx'))) continue
          // src/pages/foo → /pages/foo/index；src/pkg-x/pages/foo → /pkg-x/pages/foo/index
          out.push({ route: `/${rel.replace(/^src\//, '')}/index`, file: rel })
        }
        continue
      }
      walk(full)
    }
  }
  walk(path.join(miniappRoot.pathname, 'src'))
  return out
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

  test('磁盘上的每个页面目录都在 app.config.ts 声明（孤儿页面目录会在这里失败）', () => {
    const disk = pageDirsOnDisk()
    // 自检：磁盘扫描必须真的找到页面，否则这条测试是空转
    expect(disk.length).toBe(declared.length)
    const orphans = disk.filter((p) => !declaredRouteSet.has(p.route))
    expect(orphans.map((o) => `${o.file} → ${o.route}`)).toEqual([])
  })

  test('动态拼接路由模板的静态前缀与白名单一致（漏掉分包 root 会在这里失败）', () => {
    const problems: string[] = []
    for (const found of dynamicTemplates) {
      const entries = DYNAMIC_ROUTE_TEMPLATES.filter((e) => e.file === found.file)
      if (entries.length === 0) {
        problems.push(
          `${found.file}:${found.line} 出现动态路由模板但白名单没有该文件：${found.literal}`,
        )
        continue
      }
      const prefix = staticPrefix(found.literal)
      if (!entries.some((e) => staticPrefix(e.literal) === prefix)) {
        problems.push(
          `${found.file}:${found.line} 静态前缀 ${prefix} 与白名单不符（白名单：${entries
            .map((e) => staticPrefix(e.literal))
            .join(' | ')}）`,
        )
      }
    }
    // 反向：白名单条目不能在源码里找不到，否则会留下过期登记
    for (const entry of DYNAMIC_ROUTE_TEMPLATES) {
      const stillThere = dynamicTemplates.some(
        (f) => f.file === entry.file && staticPrefix(f.literal) === staticPrefix(entry.literal),
      )
      if (!stillThere)
        problems.push(`白名单条目已过期（源码里找不到）：${entry.file} ${entry.literal}`)
    }
    expect(problems).toEqual([])
  })

  test('动态路由落点：声明 + 磁盘存在 + 页面名字面量真的出现在同文件源码里', () => {
    const problems: string[] = []
    for (const template of DYNAMIC_ROUTE_TEMPLATES) {
      const prefix = staticPrefix(template.literal)
      const source = scannedSources.get(template.file) ?? ''
      for (const route of template.candidates) {
        if (!route.startsWith(prefix)) {
          problems.push(`${template.literal} 的静态前缀 ${prefix} 不是落点 ${route} 的前缀`)
        }
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
        // 页面名必须以**带引号的字面量**出现在同文件里：否则 candidates 只是手写常量，
        // 代码里把 'report-listing' 改成 'report-listing-TYPO' 也拦不住（审查实测的漏报）。
        const pageName = path.posix.basename(path.posix.dirname(route))
        const quoted = [`'${pageName}'`, `"${pageName}"`, `\`${pageName}\``]
        if (!quoted.some((q) => source.includes(q))) {
          problems.push(
            `${template.file} 里找不到带引号的页面名 ${pageName}（candidates 与代码取值脱钩）`,
          )
        }
      }
    }
    expect(problems).toEqual([])
  })

  test('路由字符串拼接根必须显式登记（把 pages 目录前缀与 /index 拼起来的写法）', () => {
    const unexpected = concatRoots.filter((c) => !CONCAT_ROUTE_ROOTS.includes(c.root))
    expect(unexpected.map((c) => `${c.file}:${c.line} → ${c.root}`)).toEqual([])
  })

  test('扫描器自检：动态路径段归模板扫描，动态 query 归字面量扫描（分工不能有缺口）', () => {
    // 下面几个样本是**喂给正则的输入**，要的就是字面量 `${…}` 文本本身，不是插值。
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样本要的是字面量 ${...} 文本
    const pathDynamic = '`/pkg-trade/pages/${page}/index?reportId=${encodeURIComponent(id)}`'
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样本要的是字面量 ${...} 文本
    const midDynamic = '`/pkg-browse/pages/report-${kind}/index`'
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 样本要的是字面量 ${...} 文本
    const queryDynamic = '`/pkg-browse/pages/listing-detail/index?id=${id}`'
    const noDynamic = '`/pkg-browse/pages/mylist/index`'
    expect([...pathDynamic.matchAll(DYNAMIC_ROUTE_TEMPLATE)].map((m) => m[1])).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 期望值同样是字面量文本
      '/pkg-trade/pages/${page}/index?reportId=${encodeURIComponent(id)}',
    ])
    expect([...midDynamic.matchAll(DYNAMIC_ROUTE_TEMPLATE)].length).toBe(1)
    expect([...queryDynamic.matchAll(DYNAMIC_ROUTE_TEMPLATE)].length).toBe(0)
    // 动态 query 的模板必须被字面量扫描接住，否则就是两不管的缺口
    expect([...queryDynamic.matchAll(ROUTE_LITERAL)].map((m) => m[2])).toEqual([
      '/pkg-browse/pages/listing-detail/index',
    ])
    expect([...noDynamic.matchAll(ROUTE_LITERAL)].map((m) => m[2])).toEqual([
      '/pkg-browse/pages/mylist/index',
    ])
  })
})
