import { describe, expect, test } from 'bun:test'

/**
 * 首页页头色块的**几何归属**（#682）。
 *
 * 原来的色块是一块 `position: absolute`、固定 504rpx 高的背板（`@include page-hero(504px, 64px)`）。
 * 它有两个不改就一定会回来的毛病：
 *
 * ① **高度写死**：金刚区（分类图标条）底部随机型/状态栏浮动，色块却永远铺到 504rpx，
 *    两者对不上；
 * ② **定位元素压静态内容**：同一层叠上下文里，绝对定位元素绘制在静态流内元素之上。
 *    有卡片时看不出问题，是因为 `.pcard` 自己是 `position: relative`、顺序在后压住了色块；
 *    缺省页 `.empty` 是静态块 —— 真机上表现为「这个分类还没有闲置」被色块下缘从字中间截断。
 *
 * 修法是把色块换成**包住「顶栏占位块 + 金刚区」的流内容器**：高度由内容决定，
 * 且流内元素压不住后面的内容。这三条性质都要钉住，否则任何一条被改回去，遮挡都会复现，
 * 而静态检查（含类型检查）一条都不会响。
 *
 * 本仓 `tests/` 没有 Taro 组件渲染基建，只能读源码钉住结构（先例
 * `tests/back-top-scroll-source.test.ts`）。注意断言必须做**配平扫描**而不是比较
 * `indexOf` 先后关系：「闭合标签提前」这种改法能让先后顺序照样成立，却把金刚区丢到容器外面。
 */

const homePage = new URL('../src/pages/home/index.tsx', import.meta.url)
const homeStyle = new URL('../src/pages/home/index.scss', import.meta.url)

/**
 * 去掉注释后的源码：注释里正解释着「原来的色块是绝对定位」，拿原文做反面断言会误判。
 * 按引号状态机走，不认识的 `//` 一律当注释结尾 —— 但要放过 `url(http://…)` 这类
 * 「冒号后面的 `//`」，否则会把同一行的真代码一起截掉，反面断言就成了假阳。
 */
function code(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i] ?? ''
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch
      i += 1
      while (i < source.length) {
        const inner = source[i] ?? ''
        out += inner
        i += 1
        if (inner === '\\') {
          out += source[i] ?? ''
          i += 1
          continue
        }
        if (inner === ch) break
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '/' && source[i + 1] === '/' && source[i - 1] !== ':') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      continue
    }
    out += ch
    i += 1
  }
  return out
}

async function pageCode(): Promise<string> {
  return code(await Bun.file(homePage).text())
}

async function styleCode(): Promise<string> {
  return code(await Bun.file(homeStyle).text())
}

/** 取某个 scss 规则块的**完整**内容：按 `{` / `}` 配平，嵌套规则一并返回 */
function ruleBlock(style: string, selector: string): string {
  const open = style.indexOf(`${selector} {`)
  expect(open, `缺少样式块：${selector}`).toBeGreaterThanOrEqual(0)
  const start = style.indexOf('{', open)
  let depth = 0
  for (let i = start; i < style.length; i += 1) {
    if (style[i] === '{') depth += 1
    else if (style[i] === '}') {
      depth -= 1
      if (depth === 0) return style.slice(start + 1, i)
    }
  }
  throw new Error(`样式块未闭合：${selector}`)
}

/**
 * 取 JSX 容器（`<View className="…">…</View>`）包住的源码：按标签开闭配平，
 * 自闭合标签（`<Image />` 之类）不参与配对。用先后顺序断言是拦不住
 * 「闭合标签提前」的回归的，必须真的算出容器的边界。
 */
/** JSX 标签的 `>` 结尾位置：跳过属性里的字符串与 `{…}` 表达式（`onClick={() => …}` 里就有 `>`） */
function tagEndFrom(page: string, from: number): number {
  let braces = 0
  let quote = ''
  for (let i = from; i < page.length; i += 1) {
    const ch = page[i] ?? ''
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '{') braces += 1
    else if (ch === '}') braces -= 1
    else if (ch === '>' && braces === 0) return i
  }
  return -1
}

function containerBody(page: string, marker: string): string {
  const anchor = page.indexOf(marker)
  expect(anchor, `缺少容器：${marker}`).toBeGreaterThanOrEqual(0)
  const openAt = page.lastIndexOf('<', anchor)
  const tag = /<\/?[A-Za-z][\w.]*/g
  tag.lastIndex = openAt
  let depth = 0
  for (let match = tag.exec(page); match; match = tag.exec(page)) {
    const tagEnd = tagEndFrom(page, match.index + match[0].length)
    if (tagEnd === -1) break
    if (page[tagEnd - 1] === '/') continue
    depth += match[0].startsWith('</') ? -1 : 1
    if (depth === 0) return page.slice(openAt, match.index)
  }
  throw new Error(`容器未闭合：${marker}`)
}

describe('首页页头色块（#682）', () => {
  test('色块挂在流内容器 `.home__head` 上，不再写死高度、也不是定位元素', async () => {
    const head = ruleBlock(await styleCode(), '.home__head')
    // 底色留在页头（2026-11-06 Owner 指定的浅蓝页头）
    expect(head).toContain('background: var(--grad-page)')
    // 下缘 64rpx 圆角是设计稿的形状，容器替掉背板后仍要保留
    expect(head).toContain('border-radius: 0 0 64px 64px')
    // 两条回归线：写死高度 → 又会对不上金刚区；定位 → 又可能压住静态内容
    expect(head).not.toContain('position:')
    expect(head).not.toContain('height:')
    expect(head).not.toContain('top:')
  })

  test('旧的绝对定位背板与首页自制空态都已删除', async () => {
    const style = await styleCode()
    // `page-hero` 是那套「绝对定位 + 写死高度」的背板 mixin，首页不得再引用
    expect(style).not.toContain('page-hero(')
    expect(style).not.toContain('.home__hero-bg')
    // 空态改走共享组件，页面级样式随之作废
    expect(style).not.toContain('.home__empty')

    const page = await pageCode()
    expect(page).not.toContain('home__hero-bg')
    expect(page).not.toContain('home__empty')
  })

  test('色块容器确实包住了顶栏占位块与金刚区，且不含吸顶分类条', async () => {
    const page = await pageCode()
    const body = containerBody(page, 'className="home__head"')
    // 顶栏是 `fixed`，色块这一层高度只能靠它自己的等高占位块撑起来
    expect(body).toContain('<TopBar')
    expect(body).toContain('spacer')
    expect(body).toContain('className="home__cats-wrap"')
    // 吸顶分类条是 `fixed`、且要盖在色块之上，它必须在容器之外
    expect(body).not.toContain('home__catnav')
    // 商品瀑布流同理：色块高度不该被列表内容反推
    expect(body).not.toContain('home__grid')
  })

  test('缺省页走共享 EmptyState，两处语义的文案不变', async () => {
    const page = await pageCode()
    expect(page).toContain("import EmptyState from '@/components/empty-state'")
    expect(page).toContain('<EmptyState')
    // 「这个分类确实没货」与「用户自己全标了不感兴趣」是两种空，说反了就变成把用户
    // 的操作结果当成事实缺失（`pages/search` 同款口径）
    expect(page).toContain('这个分类还没有闲置')
    expect(page).toContain('这些商品都不感兴趣了')
    expect(page).toContain('换个分类看看，或到许愿墙发一条心愿')
    expect(page).toContain('这个分类的闲置都被你标过「不感兴趣」，换个分类看看')
  })
})
