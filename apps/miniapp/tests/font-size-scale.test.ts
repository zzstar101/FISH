/**
 * #628 字号阶梯守门（`apps/miniapp`）
 *
 * 硬规则：
 * 1) `font-size` 只写 `var(--fs-*)`，档位就是 `DESIGN.md` §5.1 那张表（令牌 ↔ 表 ↔ 折合 pt 三方对齐）；
 * 2) 确实算不出固定档位的（`calc()`、SCSS 变量运算）必须按「文件 + 声明原文」登记进
 *    `CALCULATED_EXCEPTIONS`，且登记的形态必须是计算式 —— 纯 px 字面量不许走这条通道；
 * 3) 历史字面量按「文件 → 取值 → 处数」冻结成债务基线 `FROZEN_LITERALS`（多重集比对），
 *    改值、跨文件挪动、新增都会报红；归位一处就同步下调。
 *
 * 扫描面（违反即报红）：
 * - `src/**\/*.scss|css` 的 `font-size:` 声明；`font:` 简写（含 SCSS 嵌套 `font: { size: … }`）单独一条用例守；
 * - `src/**\/*.ts|tsx` 的内联 `fontSize`、内联 `font:` 简写、以及出现 `--fs-*`（内联覆盖阶梯）；
 * - `src/**\/*.wxml` 的内联 `font-size`（当前仓库是 Taro React，src 下无 wxml，属预留）；
 * - `_token-vars.scss` 之外重定义 `--fs-*`（页面级局部覆盖会让阶梯形同虚设）。
 *
 * 已知盲区（管不到，改这些地方要人工看一眼）：
 * - `@include num-badge(直径, 字号, …)` 的第二参数是字号但不是 `font-size:` 声明 ——
 *   由「num-badge 的字号参数」那条用例守着（只允许令牌）；
 * - SCSS 变量间接引用字号：`$x: 23px; font-size: $x;` 这种别名会被「例外必须是计算式」
 *   那条解出右值后拒掉，但更深的套娃（`$x: $y` 且 `$y: 23px`）只查一层。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const APP = path.join(import.meta.dir, '..')
const SRC = path.join(APP, 'src')
const TOKEN_VARS = path.join(SRC, 'styles', '_token-vars.scss')
const PAGE_TOKENS = path.join(SRC, 'styles', '_tokens.scss')
const DESIGN = path.join(APP, 'DESIGN.md')

/** 阶梯允许的档位（小 → 大）。**全部是偶数 px（= 整 pt）**，没有例外。 */
const LADDER = [
  '--fs-2xs',
  '--fs-xs',
  '--fs-sm',
  '--fs-body',
  '--fs-lead',
  '--fs-title',
  '--fs-lg',
  '--fs-h3',
  '--fs-h2',
  '--fs-h1',
] as const

/**
 * 算出来的字号：按「文件 + 声明原文」登记，不写行号（行号会漂）。
 * `value` 必须是计算式（含 `calc(` 或 SCSS 变量 `$`），裸 px 与 `#{32px}` 这类纯字面量插值都会被拒；
 * 若登记的是裸变量名（`$font`），用例会把它的右值解出来，右值是 px 字面量同样报红。
 */
const CALCULATED_EXCEPTIONS = [
  {
    file: 'styles/_mixins.scss',
    value: '$font',
    why: '@mixin num-badge 的角标数字字号由调用方传参决定（调用点只允许传令牌，见 num-badge 那条用例）',
  },
  {
    file: 'styles/_mixins.scss',
    value: '$size * 0.42',
    why: '@mixin avatar 的首字母字号随头像直径等比缩放，落不到固定档位',
  },
] as const

/**
 * 字面量债务基线（#628 归位前冻结）：文件 → 取值 → 处数。
 * 与实际情况**严格相等**才算通过（多一处、少一处、换个取值、跨文件挪动都报红）；
 * 归位时按页面分批替换成 `var(--fs-*)`，改完一批就把这里的数字改成新的实际值，
 * 某文件清零后从这里删掉该键。新增页面/组件一律用令牌，不要往基线里加条目。
 */
const FROZEN_LITERALS: Record<string, Record<string, number>> = {
  'components/app-version/index.scss': { '20px': 1 },
  'components/auth-required/index.scss': { '24px': 1 },
  'components/empty-state/index.scss': { '26px': 1 },
  'components/legal-doc/index.scss': {
    '48px': 1,
    '27px': 2,
    '26px': 4,
    '24px': 5,
    '22px': 4,
    '20px': 1,
  },
  'components/load-error/index.scss': { '26px': 1, '24px': 1 },
  'components/order-list/index.scss': { '27px': 1, '26px': 2 },
  'components/phone-bind-sheet/index.scss': { '38px': 1 },
  'components/product-card/index.scss': { '38px': 1, '24px': 1, '22px': 1 },
  'components/review-dialog/index.scss': { '32px': 1, '29px': 1, '17px': 1 },
  'custom-tab-bar/index.scss': { '20px': 1 },
  'pages/chat/index.scss': { '29px': 1, '24px': 1, '20px': 2, '19px': 1 },
  'pages/home/index.scss': { '24px': 1 },
  'pages/profile/index.scss': { '40px': 2, '24px': 1, '22px': 1 },
  'pages/sell/index.scss': {
    '40px': 1,
    '38px': 1,
    '32px': 1,
    '27px': 1,
    '26px': 4,
    '24px': 1,
    '22px': 2,
    '20px': 4,
    '18px': 1,
    '17px': 1,
  },
  'pages/wish/index.scss': { '26px': 3, '24px': 4, '22px': 3, '20px': 5, '19px': 1 },
  'pkg-auth/pages/account-deletion/index.scss': {
    '30px': 1,
    '26px': 1,
    '25px': 3,
    '24px': 1,
    '22px': 1,
  },
  'pkg-auth/pages/login-confirm/index.scss': { '29px': 1, '27px': 1 },
  'pkg-auth/pages/login/index.scss': { '32px': 1, '24px': 1 },
  'pkg-auth/pages/profile-edit/index.scss': { '32px': 1, '24px': 3 },
  'pkg-auth/pages/settings/index.scss': { '38px': 1, '22px': 2 },
  'pkg-auth/pages/verify/index.scss': { '1px': 1 },
  'pkg-browse/pages/comments/index.scss': { '26px': 1, '22px': 1, '20px': 2, '19px': 1 },
  'pkg-browse/pages/favorites/index.scss': { '26px': 2, '22px': 2, '19px': 1 },
  'pkg-browse/pages/following/index.scss': { '27px': 1, '24px': 1 },
  'pkg-browse/pages/history/index.scss': {
    '27px': 1,
    '26px': 1,
    '22px': 1,
    '20px': 2,
    '19px': 1,
    '18px': 1,
  },
  'pkg-browse/pages/listing-detail/index.scss': {
    '68px': 1,
    '32px': 1,
    '30px': 1,
    '29px': 2,
    '27px': 4,
    '26px': 5,
    '24px': 4,
  },
  'pkg-browse/pages/match/index.scss': {
    '48px': 1,
    '32px': 1,
    '29px': 1,
    '27px': 1,
    '24px': 2,
    '22px': 1,
    '20px': 1,
  },
  'pkg-browse/pages/mylist/index.scss': {
    '32px': 1,
    '29px': 1,
    '26px': 1,
    '24px': 2,
    '22px': 4,
    '20px': 1,
  },
  'pkg-browse/pages/search/index.scss': {
    '32px': 1,
    '26px': 3,
    '24px': 2,
    '22px': 2,
    '19px': 1,
    '18px': 1,
  },
  'pkg-browse/pages/user/index.scss': {
    '44px': 1,
    '40px': 1,
    '26px': 1,
    '24px': 1,
    '22px': 1,
    '20px': 2,
  },
  'pkg-browse/pages/watchers/index.scss': { '52px': 1, '26px': 1, '24px': 1, '22px': 4 },
  'pkg-legal/pages/about/index.scss': { '44px': 1, '27px': 1, '26px': 1, '22px': 1 },
  'pkg-legal/pages/feedback/index.scss': { '48px': 1, '32px': 1, '26px': 3, '24px': 1, '20px': 1 },
  'pkg-legal/pages/my-feedback/index.scss': { '48px': 1, '20px': 4 },
  // 16px 是 #602 给「在线态文案」写的新值（8pt，比阶梯最小的 10pt 还小一档，属阶梯外尺寸，见 §5.2）
  'pkg-social/pages/conversation/index.scss': {
    '26px': 1,
    '24px': 1,
    '22px': 4,
    '20px': 3,
    '16px': 1,
  },
  'pkg-social/pages/wish-publish/index.scss': { '29px': 2, '24px': 1 },
  'pkg-trade/pages/dispute-detail/index.scss': { '20px': 2 },
  'pkg-trade/pages/my-disputes/index.scss': { '20px': 2 },
  'pkg-trade/pages/my-reports/index.scss': { '27px': 1, '22px': 1, '20px': 3 },
  'pkg-trade/pages/report-listing/index.scss': {
    '48px': 1,
    '32px': 1,
    '27px': 2,
    '26px': 4,
    '24px': 1,
    '22px': 2,
    '20px': 2,
    '19px': 1,
  },
  'pkg-trade/pages/report-user/index.scss': {
    '48px': 1,
    '32px': 1,
    '27px': 2,
    '26px': 4,
    '24px': 1,
    '22px': 2,
    '20px': 2,
    '19px': 1,
  },
  'pkg-trade/pages/send-listing/index.scss': { '26px': 3 },
  'pkg-trade/pages/transaction-meetup/index.scss': {
    '88px': 1,
    '48px': 1,
    '44px': 1,
    '32px': 1,
    '30px': 1,
    '27px': 2,
    '1px': 1,
  },
  // #637 删除旧页债务；搬入 scan 的 22px 标签按 #628 使用等值 --fs-xs，不新增债务。
  'pkg-vision/pages/scan/index.scss': { '26px': 2, '29px': 1 },
  'pkg-vision/pages/vision-result/index.scss': {
    '40px': 1,
    '29px': 1,
    '26px': 3,
    '24px': 3,
    '19px': 1,
    '16px': 1,
  },
  'styles/_mixins.scss': { '20px': 1 },
}

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, ext, acc)
    else if (entry.endsWith(ext)) acc.push(full)
  }
  return acc
}

/** 剥掉注释，避免注释里的示例文字被当成声明。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const toPosix = (file: string) => path.relative(SRC, file).split(path.sep).join('/')
const lineOf = (code: string, index: number) => code.slice(0, index).split('\n').length

/** 令牌真源：`--fs-xxx: NNpx;` */
function readTokenValues(): Map<string, number> {
  const code = stripComments(readFileSync(TOKEN_VARS, 'utf8'))
  const out = new Map<string, number>()
  for (const m of code.matchAll(/^\s*(--fs-[\w-]+):\s*(\d+(?:\.\d+)?)px;/gim)) {
    out.set(m[1], Number(m[2]))
  }
  return out
}

/** DESIGN.md §5.1 的表格：`| `--fs-xxx` | 32 | 16pt | 用途 |` */
function readDocTable(): Map<string, { px: number; pt: number }> {
  const md = readFileSync(DESIGN, 'utf8')
  const out = new Map<string, { px: number; pt: number }>()
  for (const m of md.matchAll(
    /^\|\s*`(--fs-[\w-]+)`\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)pt\s*\|/gm,
  )) {
    out.set(m[1], { px: Number(m[2]), pt: Number(m[3]) })
  }
  return out
}

type Decl = { file: string; line: number; value: string }

function readFontSizeDecls(): Decl[] {
  const decls: Decl[] = []
  for (const file of [...walk(SRC, '.scss'), ...walk(SRC, '.css')]) {
    const code = stripComments(readFileSync(file, 'utf8'))
    const re = /(?<![\w-])font-size\s*:\s*([^;{}]+)/gi
    for (const m of code.matchAll(re)) {
      decls.push({ file: toPosix(file), line: lineOf(code, m.index), value: m[1].trim() })
    }
  }
  return decls
}

/** `font:` 简写（含 SCSS 嵌套 `font: { size: … }`）——字号的等价通道，一律不许用。 */
function readFontShorthands(): string[] {
  const hits: string[] = []
  for (const file of walk(SRC, '.scss')) {
    const code = stripComments(readFileSync(file, 'utf8'))
    // `$font:` 是 SCSS 变量赋值、`font-family:` 等冒号不在 font 后面，都不该被当成简写
    for (const m of code.matchAll(/(?<![\w$-])font\s*:\s*([^;{}]*)/gi)) {
      const rest = m[1].trim()
      if (rest === '') continue
      hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  font: ${rest}`)
    }
    for (const m of code.matchAll(/(?<![\w$-])font\s*:\s*\{([^}]*)\}/gi)) {
      for (const inner of m[1].matchAll(/(?<![\w$-])size\s*:\s*([^;{}]+)/gi)) {
        hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  font: { size: ${inner[1].trim()} }`)
      }
    }
  }
  return hits
}

/** `_token-vars.scss` 之外重定义 `--fs-*`（页面级局部覆盖会让阶梯形同虚设）。 */
function readTokenRedefinitions(): string[] {
  const hits: string[] = []
  for (const file of walk(SRC, '.scss')) {
    if (path.resolve(file) === path.resolve(TOKEN_VARS)) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const m of code.matchAll(/(?<![\w-])(--fs-[\w-]+)\s*:/gi)) {
      hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  ${m[1]}:`)
    }
  }
  return hits
}

/** `@include num-badge(直径, 字号, ...)` 的字号参数（第二位置参数，或 `$font:` 具名参数）。 */
function readNumBadgeFontArgs(): { file: string; value: string }[] {
  const out: { file: string; value: string }[] = []
  for (const file of walk(SRC, '.scss')) {
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const m of code.matchAll(/@include\s+num-badge\s*\(/gi)) {
      // 参数里可能嵌括号（如 var(--fs-2xs)），按括号深度截取实参串
      const start = m.index + m[0].length
      let depth = 1
      let i = start
      while (i < code.length && depth > 0) {
        if (code[i] === '(') depth++
        else if (code[i] === ')') depth--
        i++
      }
      const body = code.slice(start, i - 1)

      // 只在深度 0 处按逗号切分
      const args: string[] = []
      let buf = ''
      let d = 0
      for (const ch of body) {
        if (ch === '(') d++
        if (ch === ')') d--
        if (ch === ',' && d === 0) {
          args.push(buf.trim())
          buf = ''
        } else {
          buf += ch
        }
      }
      if (buf.trim()) args.push(buf.trim())

      const named = args.find((a) => /^\$font\s*:/.test(a))
      const positional = args[1]
      const value = named
        ? named.replace(/^\$font\s*:\s*/, '').trim()
        : // 只传别的具名参数（如 `$ring: 4px`）＝ 用 mixin 默认令牌字号，不算违规
          positional && !/^\$[\w-]+\s*:/.test(positional)
          ? positional
          : undefined
      if (value) out.push({ file: toPosix(file), value })
    }
  }
  return out
}

/** 源码里的内联字号：ts/tsx 的 `fontSize`、`font:` 简写、`--fs-*`，wxml 的 `font-size`。 */
function readInlineFontSizes(): string[] {
  const hits: string[] = []
  for (const ext of ['.ts', '.tsx']) {
    for (const file of walk(SRC, ext)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const m of code.matchAll(/font-?size/gi)) {
        hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  fontSize`)
      }
      // `style={{ font: '20px serif' }}` 与 wxss 的 `font:` 简写等价；`fontFamily:` 之类不会命中
      for (const m of code.matchAll(/(?<![\w-])font\s*:\s*['"`]/gi)) {
        hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  font 简写`)
      }
      // 内联写 `style={{ '--fs-body': '40px' }}` 等于就地重定义阶梯
      for (const m of code.matchAll(/--fs-[\w-]+/gi)) {
        hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  --fs-* 出现在源码里`)
      }
    }
  }
  for (const file of walk(SRC, '.wxml')) {
    const code = readFileSync(file, 'utf8')
    for (const m of code.matchAll(/font-?size\s*:/gi)) {
      hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  font-size`)
    }
    for (const m of code.matchAll(/--fs-[\w-]+/gi)) {
      hits.push(`${toPosix(file)}:${lineOf(code, m.index)}  --fs-* 出现在源码里`)
    }
  }
  return hits
}

/** 全仓 `page` 选择器块里的 `font-size`（基准字号只允许一条，且必须是 `--fs-body`）。 */
function readPageBaseFontSizes(): string[] {
  const found: string[] = []
  for (const file of walk(SRC, '.scss')) {
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const block of code.matchAll(/(^|[\s}])page\s*\{([^}]*)\}/gi)) {
      for (const decl of block[2].matchAll(/font-size\s*:\s*([^;{}]+)/gi)) {
        found.push(`${toPosix(file)}  font-size: ${decl[1].trim()}`)
      }
    }
  }
  return found
}

// 全部在模块加载时算一次：每个用例只做比对（避免首次运行在用例体内 walk 整个 src 超时）
const DECLS = readFontSizeDecls()
const TOKENS = readTokenValues()
const DOC = readDocTable()
const SHORTHANDS = readFontShorthands()
const TOKEN_REDEFS = readTokenRedefinitions()
const NUM_BADGE_ARGS = readNumBadgeFontArgs()
const INLINE = readInlineFontSizes()
const PAGE_BASE = readPageBaseFontSizes()

const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])
const normalizeValue = (value: string) => value.replace(/!important/gi, '').replace(/\s+/g, '')
const isTokenRef = (value: string) => {
  const normalized = normalizeValue(value)
  return /^var\(--fs-[\w-]+\)$/i.test(normalized) || CSS_WIDE_KEYWORDS.has(normalized.toLowerCase())
}
const isPxLiteral = (value: string) => /^\d+(?:\.\d+)?px$/i.test(value)
const registered = new Set(CALCULATED_EXCEPTIONS.map((e) => `${e.file}::${e.value}`))

/** 实际的字面量分布（文件 → 取值 → 处数），与 `FROZEN_LITERALS` 做多重集比对。 */
function readLiteralCounts(): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>()
  for (const decl of DECLS) {
    if (!isPxLiteral(decl.value)) continue
    if (registered.has(`${decl.file}::${decl.value}`)) continue
    const inner = counts.get(decl.file) ?? new Map<string, number>()
    inner.set(decl.value, (inner.get(decl.value) ?? 0) + 1)
    counts.set(decl.file, inner)
  }
  return counts
}

const LITERALS = readLiteralCounts()
const LITERAL_TOTAL = [...LITERALS.values()].reduce(
  (sum, inner) => sum + [...inner.values()].reduce((a, b) => a + b, 0),
  0,
)

describe('#628 字号阶梯：令牌与文档', () => {
  test('阶梯档位与 DESIGN.md §5.1 表格一一对应', () => {
    expect([...TOKENS.keys()].sort()).toEqual([...LADDER].sort())
    expect([...DOC.keys()].sort()).toEqual([...LADDER].sort())
    for (const name of LADDER) {
      expect({ name, px: DOC.get(name)?.px }).toEqual({ name, px: TOKENS.get(name) })
    }
  })

  test('文档里的折合 pt 与令牌 px 一致（pt = px / 2）', () => {
    for (const [name, px] of TOKENS) {
      expect({ name, pt: DOC.get(name)?.pt }).toEqual({ name, pt: px / 2 })
    }
  })

  test('档位 px 唯一，且全部是偶数 px（= 整 pt）', () => {
    const values = [...TOKENS.values()]
    expect(new Set(values).size).toBe(values.length)
    for (const [name, px] of TOKENS) {
      expect({ name, wholePt: px % 2 === 0 }).toEqual({ name, wholePt: true })
    }
  })

  // 守的是既有资产（`_tokens.scss` 的 page 基准，本 PR 未改），目的是防止有人把基准改成
  // 硬编码 px、或另起一个 page 块把基准换成别的档位 —— 不是为本次行为写的用例。
  test('全仓 page 块的基准字号恰好一条，且取 --fs-body', () => {
    expect(PAGE_BASE).toEqual([`${toPosix(PAGE_TOKENS)}  font-size: var(--fs-body)`])
  })

  test('DESIGN.md §5.2 写的债务数字与实际基线一致', () => {
    const md = readFileSync(DESIGN, 'utf8')
    const m = /\*\*(\d+) 处 \/ (\d+) 个文件\*\*/.exec(md)
    expect({ total: m?.[1], files: m?.[2] }).toEqual({
      total: String(LITERAL_TOTAL),
      files: String(LITERALS.size),
    })
  })
})

describe('#628 字号阶梯：调用点', () => {
  test('font-size 只能是 var(--fs-*)、CSS 全局关键字、登记过的计算例外，或债务基线内的字面量', () => {
    const unregistered: string[] = []
    for (const decl of DECLS) {
      const { file, line, value } = decl
      if (isTokenRef(value)) continue
      if (registered.has(`${file}::${value}`)) continue
      if (isPxLiteral(value)) continue
      unregistered.push(`${file}:${line}  font-size: ${value}`)
    }
    expect(unregistered).toEqual([])
  })

  test('调用的令牌必须真的在阶梯里（`var(--fs-h9)` 这类写错要报红）', () => {
    const unknown = DECLS.filter((d) => {
      const name = /^var\((--fs-[\w-]+)\)$/i.exec(normalizeValue(d.value))
      return name !== null && !LADDER.includes(name[1] as (typeof LADDER)[number])
    }).map((d) => `${d.file}:${d.line}  font-size: ${d.value}`)
    expect(unknown).toEqual([])
  })

  test('字面量债务必须与基线严格一致（改值、跨文件挪动、新增都算漂移）', () => {
    const drifted: string[] = []
    const files = new Set([...LITERALS.keys(), ...Object.keys(FROZEN_LITERALS)])

    for (const file of files) {
      const actual = LITERALS.get(file) ?? new Map<string, number>()
      const frozen = FROZEN_LITERALS[file] ?? {}
      const values = new Set([...actual.keys(), ...Object.keys(frozen)])
      for (const value of values) {
        const a = actual.get(value) ?? 0
        const f = frozen[value] ?? 0
        if (a !== f) drifted.push(`${file} 的 ${value}：基线 ${f} 处，实际 ${a} 处`)
      }
    }

    expect(drifted).toEqual([])
  })

  test('计算例外必须是计算式，且登记项真的存在（防登记腐烂 / 防洗白字面量）', () => {
    for (const exception of CALCULATED_EXCEPTIONS) {
      // `#{32px}` 这类纯字面量插值不算计算式：必须真有 calc() 或 SCSS 变量参与
      const looksComputed = /calc\(|\$/.test(exception.value)
      expect({ value: exception.value, looksComputed }).toEqual({
        value: exception.value,
        looksComputed: true,
      })
      expect({ value: exception.value, isBarePx: isPxLiteral(exception.value) }).toEqual({
        value: exception.value,
        isBarePx: false,
      })

      // 裸变量名要把右值解出来：`$x: 23px;` 这种别名等于把 px 洗白
      const bare = /^\$[\w-]+$/.exec(exception.value.trim())
      if (bare) {
        const code = stripComments(readFileSync(path.join(SRC, exception.file), 'utf8'))
        const declRe = new RegExp(`(^|[\\s;}])${bare[0].replace('$', '\\$')}\\s*:\\s*([^;]+);`)
        const right = declRe.exec(code)?.[2]?.trim() ?? ''
        expect({ variable: bare[0], rightIsBarePx: isPxLiteral(right) }).toEqual({
          variable: bare[0],
          rightIsBarePx: false,
        })
      }

      const used = DECLS.some((d) => d.file === exception.file && d.value === exception.value)
      expect({ value: exception.value, used }).toEqual({ value: exception.value, used: true })
    }
  })

  test('num-badge 的字号参数只能传令牌（不许再写 px 字面量）', () => {
    const offenders = NUM_BADGE_ARGS.filter((arg) => !isTokenRef(arg.value)).map(
      (arg) => `${arg.file}  @include num-badge(…, ${arg.value}, …)`,
    )
    expect(offenders).toEqual([])
  })

  test('源码里不出现内联字号（ts/tsx 的 fontSize / font 简写 / --fs-*，wxml 的 font-size）', () => {
    expect(INLINE).toEqual([])
  })

  test('不许用 font 简写（含 SCSS 嵌套 font: { size: … }）写字号', () => {
    expect(SHORTHANDS).toEqual([])
  })

  test('_token-vars.scss 之外不许重定义 --fs-*（页面级覆盖会让阶梯形同虚设）', () => {
    expect(TOKEN_REDEFS).toEqual([])
  })
})
