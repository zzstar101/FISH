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
 * `tests/back-top-scroll-source.test.ts`）。
 */

const homePage = new URL('../src/pages/home/index.tsx', import.meta.url)
const homeStyle = new URL('../src/pages/home/index.scss', import.meta.url)

/** 去掉注释后的源码：注释里正解释着「原来的色块是绝对定位」，拿原文做反面断言会误判 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function pageCode(): Promise<string> {
  return code(await Bun.file(homePage).text())
}

async function styleCode(): Promise<string> {
  return code(await Bun.file(homeStyle).text())
}

/** 取某个 scss 规则块（`selector {` 到其后第一个 `}`）的内容 */
function ruleBlock(style: string, selector: string): string {
  const start = style.indexOf(`${selector} {`)
  expect(start, `缺少样式块：${selector}`).toBeGreaterThanOrEqual(0)
  const end = style.indexOf('}', start)
  expect(end, `样式块未闭合：${selector}`).toBeGreaterThan(start)
  return style.slice(start + selector.length, end)
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

  test('色块容器确实包住了顶栏占位块与金刚区', async () => {
    const page = await pageCode()
    const head = page.indexOf('className="home__head"')
    const topbar = page.indexOf('<TopBar')
    const cats = page.indexOf('className="home__cats-wrap"')
    // 金刚区之后的第一条分类导航是 `fixed` 的吸顶条，它必须在色块容器之外
    const catnav = page.indexOf('className={`home__catnav')
    expect(head, '缺少 .home__head 容器').toBeGreaterThanOrEqual(0)
    expect(topbar, '缺少 <TopBar>').toBeGreaterThan(head)
    expect(cats, '缺少金刚区 .home__cats-wrap').toBeGreaterThan(topbar)
    expect(catnav, '缺少吸顶分类条 .home__catnav').toBeGreaterThan(cats)
    // 顶栏是 `fixed`，色块这一层高度只能靠它自己的等高占位块撑起来
    expect(page.slice(topbar, cats)).toContain('spacer')
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
