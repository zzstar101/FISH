import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * 图标显示尺寸守卫（#513 根因 4）。
 *
 * 图标资源按 32pt 出图（96px = 32pt@3x，#660 由 24pt 抬升），SCSS 里 px 即 rpx（DESIGN.md §1），
 * 所以 64 是唯一不缩放的尺寸。尺寸只落在 24/32/40/48/56/64 六档，且是正方形
 * （#660 新增 56/64：方片 72 里 48 的图标只占 2/3，行图标显得比宫格小一档）。
 *
 * 扫描口径：
 * - `src/` 下 tsx 里 `src` 是 `ICONS.xxx` / `ICONS[...]` / `HOME_CATEGORY_ICONS[...]` 的 `<Image>`；
 * - 加上 `INDIRECT_ICON_IMAGES` 登记的、经变量/props 拿到 `ICONS` 值的 `<Image>`（含 TabBar）。
 *
 * 每个图标取 className 里的 BEM 类（`block__elem`），到**同目录**的 `.scss` 里找命中该类的规则
 * （选择器最后一段含 `.类名`，`&` 嵌套会展开），要求：
 * - 至少有一条规则同时写了 `width` 与 `height`，且两者相等；
 * - 所有命中规则里的 `width` / `height` 都是四档之一的 `Npx`。
 * 尺寸写在运行时 inline style 里的，必须登记在 `INLINE_SIZED_ICONS` 并说明理由；
 * 其余解析不出来的一律报失败，不静默跳过。
 *
 * ## 已知盲区
 * - `src` 来自变量、又没登记在 `INDIRECT_ICON_IMAGES` 的新图标（新增时请登记）；
 * - 跨目录复用的 className（scss 不在 tsx 同目录）会直接报「找不到尺寸」，需要时再扩展查找范围。
 */

const SRC = path.join(import.meta.dir, '../src')
const TIERS = new Set([24, 32, 40, 48, 56, 64])
const ICON_SRC = /\b(?:ICONS|HOME_CATEGORY_ICONS)\s*[.[]/

/** src 不是图标表达式字面量、但渲染的就是 `ICONS` 图标的 `<Image>`（路径相对 `src/`）。 */
const INDIRECT_ICON_IMAGES = [
  { file: 'custom-tab-bar/index.tsx', className: 'tabbar__img', why: 'TAB_ITEMS 的 icon / iconOn' },
  {
    file: 'custom-tab-bar/index.tsx',
    className: 'tabbar__plus',
    why: '出物凸起钮 ICONS.plusWhite',
  },
  {
    file: 'components/empty-state/index.tsx',
    className: 'empty__icon-img',
    why: 'icon prop，默认 ICONS.tagMuted',
  },
  {
    file: 'pkg-social/pages/conversation/index.tsx',
    className: 'conv__ptile-ic',
    why: 'PANEL_TILES 的 ICONS.*',
  },
  {
    file: 'pkg-auth/pages/settings/index.tsx',
    className: 'st__ric-ic',
    why: '设置行配置的 ICONS.*',
  },
  { file: 'pages/chat/index.tsx', className: 'notif__ic-img', why: 'TONE_ICON 映射到 ICONS.*' },
  { file: 'pages/profile/index.tsx', className: 'profile__row-ic', why: '功能行配置的 ICONS.*' },
  { file: 'pages/profile/index.tsx', className: 'profile__cell-ic', why: '宫格配置的 ICONS.*' },
] as const

/**
 * 尺寸由运行时 inline style 决定的图标：自绘导航里的返回/举报钮随微信胶囊高度等比缩放
 * （`backGeo.size × N / 72`，即「72 钮配 N 图标」），scss 里没有固定尺寸。
 * 断言 style 里每个 `N / 72` 的 N 都在四档内。
 */
const INLINE_SIZED_ICONS = [
  {
    file: 'pkg-auth/pages/profile-edit/index.tsx',
    className: 'pe__back-ic',
    why: '返回钮随胶囊高度缩放：backGeo.size × 40/72',
  },
  {
    file: 'pkg-browse/pages/user/index.tsx',
    className: 'uhome__navreport-ic',
    why: '举报钮随胶囊高度缩放：backGeo.size × 40/72',
  },
] as const

type IconImage = { file: string; line: number; classes: string[]; style: string | null }

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, ext, acc)
    else if (entry.endsWith(ext)) acc.push(full)
  }
  return acc
}

/** 从 `<Image` 开始找到标签结尾的 `>`（跳过 `{…}` 表达式里的 `>`，如 `=>`）。 */
function tagAt(src: string, start: number): string {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start)
}

/** 取 JSX 属性值：`name="…"` 返回引号内文本，`name={…}` 返回含花括号的表达式。 */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}=`).exec(tag)
  if (!m) return null
  const from = m.index + m[0].length
  if (tag[from] === '"') return tag.slice(from + 1, tag.indexOf('"', from + 1))
  let depth = 0
  for (let i = from; i < tag.length; i++) {
    if (tag[i] === '{') depth++
    else if (tag[i] === '}' && --depth === 0) return tag.slice(from, i + 1)
  }
  return null
}

function bemClasses(className: string | null): string[] {
  return className?.match(/[a-z][\w-]*__[\w-]+/g) ?? []
}

const registered = (list: readonly { file: string; className: string }[], img: IconImage) =>
  list.find((e) => e.file === img.file && img.classes.includes(e.className))

function collectIconImages(): IconImage[] {
  const out: IconImage[] = []
  for (const full of walk(SRC, '.tsx')) {
    const file = path.relative(SRC, full).split(path.sep).join('/')
    const source = readFileSync(full, 'utf8')
    for (const m of source.matchAll(/<Image\s/g)) {
      const tag = tagAt(source, m.index)
      const img: IconImage = {
        file,
        line: source.slice(0, m.index).split('\n').length,
        classes: bemClasses(attr(tag, 'className')),
        style: attr(tag, 'style'),
      }
      if (ICON_SRC.test(attr(tag, 'src') ?? '') || registered(INDIRECT_ICON_IMAGES, img))
        out.push(img)
    }
  }
  return out
}

type Rule = { selector: string; decls: Map<string, string> }

/** 够用的 SCSS 规则展开：去注释、跳过 `#{…}` 插值、按 `&` / 后代关系展开嵌套选择器。 */
function scssRules(scss: string): Rule[] {
  const text = scss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  const rules: Rule[] = []
  const stack: Rule[][] = [[]]
  let buf = ''
  const flushDecl = () => {
    const at = buf.indexOf(':')
    if (at > 0) {
      for (const rule of stack[stack.length - 1] ?? [])
        rule.decls.set(buf.slice(0, at).trim(), buf.slice(at + 1).trim())
    }
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '#' && text[i + 1] === '{') {
      const end = text.indexOf('}', i)
      buf += text.slice(i, end + 1)
      i = end
    } else if (c === '{') {
      const sel = buf.trim()
      const parents = stack[stack.length - 1] ?? []
      let next: Rule[]
      if (sel.startsWith('@')) {
        next = parents // @media / @include 块：沿用外层选择器
      } else {
        const parentSels = parents.length ? parents.map((p) => p.selector) : ['']
        next = parentSels.flatMap((p) =>
          sel.split(',').map((part) => {
            const s = part.trim()
            const selector = s.includes('&') ? s.replaceAll('&', p) : `${p} ${s}`.trim()
            const rule: Rule = { selector, decls: new Map() }
            rules.push(rule)
            return rule
          }),
        )
      }
      stack.push(next)
      buf = ''
    } else if (c === ';') {
      flushDecl()
    } else if (c === '}') {
      flushDecl()
      stack.pop()
    } else {
      buf += c
    }
  }
  return rules
}

const scssCache = new Map<string, Rule[]>()
function rulesInDir(dir: string): Rule[] {
  const cached = scssCache.get(dir)
  if (cached) return cached
  const rules = readdirSync(dir)
    .filter((f) => f.endsWith('.scss'))
    .flatMap((f) => scssRules(readFileSync(path.join(dir, f), 'utf8')))
  scssCache.set(dir, rules)
  return rules
}

/** 选择器最后一段（不含伪元素）里带 `.cls` 的规则。 */
function rulesFor(rules: Rule[], cls: string): Rule[] {
  const re = new RegExp(`\\.${cls}(?![\\w-])`)
  return rules.filter((r) => {
    const last = r.selector.split(/[\s>+~]+/).pop() ?? ''
    return !last.includes('::') && re.test(last)
  })
}

function px(value: string): number | null {
  const m = value.match(/^(\d+)px$/)
  return m ? Number(m[1]) : null
}

function problemsOf(img: IconImage): string[] {
  const where = `${img.file}:${img.line} .${img.classes.join(' .') || '(无 className)'}`
  if (registered(INLINE_SIZED_ICONS, img)) {
    const ratios = [...(img.style ?? '').matchAll(/\((\d+)\s*\/\s*72\)/g)].map((m) => Number(m[1]))
    if (ratios.length === 0) return [`${where} 登记为 inline 尺寸，但 style 里找不到 N / 72`]
    return ratios.filter((n) => !TIERS.has(n)).map((n) => `${where} inline 比例 ${n}/72 不在四档`)
  }
  if (img.style && /width|height/.test(img.style))
    return [`${where} 尺寸写在 inline style 里，需登记到 INLINE_SIZED_ICONS`]

  const all = rulesInDir(path.join(SRC, path.dirname(img.file)))
  const problems: string[] = []
  let sized = false
  for (const cls of img.classes) {
    for (const rule of rulesFor(all, cls)) {
      const w = rule.decls.get('width')
      const h = rule.decls.get('height')
      if (w !== undefined && h !== undefined) {
        sized = true
        if (w !== h) problems.push(`${where} [${rule.selector}] 不是正方形：${w} × ${h}`)
      }
      for (const [prop, value] of [
        ['width', w],
        ['height', h],
      ] as const) {
        if (value === undefined) continue
        const n = px(value)
        if (n === null || !TIERS.has(n))
          problems.push(`${where} [${rule.selector}] ${prop}: ${value} 不在 24/32/40/48px`)
      }
    }
  }
  if (!sized) problems.push(`${where} 在同目录 scss 里找不到同时声明 width/height 的规则`)
  return problems
}

const icons = collectIconImages()

describe('图标显示尺寸收敛到 24/32/40/48（#513）', () => {
  test('扫描器没取空', () => {
    expect(icons.length).toBeGreaterThan(150)
  })

  test('登记项都还对应真实的 <Image>（不留过期登记）', () => {
    const stale = [...INDIRECT_ICON_IMAGES, ...INLINE_SIZED_ICONS].filter(
      (e) => !icons.some((img) => img.file === e.file && img.classes.includes(e.className)),
    )
    expect(stale.map((e) => `${e.file} .${e.className}`)).toEqual([])
  })

  test('每个图标 <Image> 的宽高都是四档之一的正方形', () => {
    expect(icons.flatMap(problemsOf)).toEqual([])
  })

  test('SCSS 展开自检：& 嵌套、插值与注释不影响取值', () => {
    const rules = scssRules(`
      /* .x__ic { width: 99px; } */
      .x { &__ic { width: 24px; height: 24px; &.is-on { width: 32px; } } }
      .y #{'a'} { height: 1px; }
    `)
    expect(rulesFor(rules, 'x__ic').map((r) => [r.selector, Object.fromEntries(r.decls)])).toEqual([
      ['.x__ic', { width: '24px', height: '24px' }],
      ['.x__ic.is-on', { width: '32px' }],
    ])
  })
})
