import { describe, expect, test } from 'bun:test'

/**
 * 回顶钮 `bottom` 传值的**页面级差异**（#319 审查 P2）。
 *
 * 共享组件 `components/back-top` 的 `bottom` 是**内联样式**（不走 pxtransform，直接传
 * `rpx` 字符串），值由「本页要避让的那个悬浮层」决定，各页并不相同：
 *
 * - 三个 Tab 页（home / chat / wish）避让**悬浮底栏**（`custom-tab-bar/`，顶边 = 距底 53
 *   + 栏高 101 = 154rpx），再留 16rpx → `170rpx`。
 * - `mylist` **不是 Tab 页**（`app.config.ts` 的 tabBar 只有 home / wish / sell / chat /
 *   profile），它右下的悬浮层是**本页自己的**「+ 发布」（`.ml__fab`：
 *   `fixed; bottom: 44px; height: 104px`）。回顶钮按 fab 几何推：
 *   44 + 104 + 40（20pt 缝）= `188rpx`。
 *
 * 期望值由**悬浮层自己的样式算出来**，不写死 `170rpx` / `188rpx`：这两个页面值都以
 * `rpx` 字符串躺在 JSX 里，抄错了不会有任何编译/运行时错误，只是按钮叠在悬浮层上
 * （或飘在半空）。写死常量的话，悬浮层再挪一次位置（#235 就是这么把三页的 145rpx
 * 变成存量错的）测试依旧全绿 —— 那正是这条用例要防的事。
 *
 * 断言切到**具体页面文件的这一行**，不查整份文件（整份文件的子串命中挡不住值被换回去）。
 */

/**
 * 取页面源码。
 *
 * Tab 页传 `<page>/…`（在主包 `src/pages/` 下）；分包页传 `pkg-<group>/pages/<page>/…`
 * （`src/<root>/` 下，root 见 `app.config.ts` 的 `subPackages`）。
 */
async function pageSource(file: string): Promise<string> {
  const base = file.startsWith('pkg-') ? '../src/' : '../src/pages/'
  return await Bun.file(new URL(`${base}${file}`, import.meta.url)).text()
}

/** 取页面里 `<BackTop ...>` 开标签的源码 */
async function backTopTag(file: string): Promise<string> {
  const source = await pageSource(file)
  const start = source.indexOf('<BackTop')
  expect(start, `${file} 里没有 <BackTop>`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('/>', start)
  expect(end, `${file} 的 <BackTop> 没有自闭合`).toBeGreaterThan(start)
  return source.slice(start, end)
}

/** 页面传给 `bottom` 的 rpx 数值（内联传值，单位就是 rpx） */
async function backTopBottom(file: string): Promise<number> {
  const tag = await backTopTag(file)
  const matched = /bottom="([\d.]+)rpx"/.exec(tag)
  expect(matched, `${file} 的 <BackTop> 没有可解析的 bottom 传值：${tag}`).not.toBeNull()
  return Number(matched?.[1])
}

/**
 * 去掉 scss 注释。
 *
 * 必须去掉再解析：`.tabbar` 的注释里正写着「稿 padding:5px 8px 7px → 10px 16px 14px」，
 * `.tabbar__icon` 的注释里写着「稿 `.tbi{height:42px}`」—— 按裸正则抓会抓到这些**文档
 * 里的旧值**，算出来的栏高正好少 20rpx（8+10 vs 5+7，56 vs 42），测试就锁错了。
 */
function stripComments(style: string): string {
  return style.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取 scss 里 `selector { ... }` 的花括号内容 */
function ruleBody(rawStyle: string, selector: string): string {
  const style = stripComments(rawStyle)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matched = new RegExp(`^${escaped} \\{`, 'm').exec(style)
  expect(matched, `scss 里没有独立的 ${selector} 规则`).not.toBeNull()
  const open = style.indexOf('{', matched?.index ?? 0)
  const close = style.indexOf('}', open)
  return style.slice(open, close)
}

/** 取某条属性的 px 数值；缺失时返回 null（用于「有就用、没有就回落」的取值） */
function pxOrNull(body: string, prop: string): number | null {
  const matched = new RegExp(`(?:^|[;{\\s])${prop}:\\s*([\\d.]+)px`).exec(body)
  return matched ? Number(matched[1]) : null
}

/** 取某条属性的 px 数值（缺失即失败） */
function px(body: string, prop: string): number {
  const value = pxOrNull(body, prop)
  expect(value, `缺少 ${prop}: <数值>px`).not.toBeNull()
  return value as number
}

/**
 * 悬浮底栏的几何（从 `custom-tab-bar/index.scss` 真读）。
 *
 * 高度取**最高那一列**：栏体是 `display:flex; align-items:center`，5 个子项各是一个
 * flex 纵向列 —— 四个普通 tab 是「`.tabbar__icon` + 行距 + 文字」，中间的凸起 tab 是
 * 「`.tabbar__pub` + 行距 + 文字」。**凸起钮才是决定栏高的那个**（设计稿里它比图标行
 * 大），今天两者都是 56px 纯属巧合 —— 只读 `.tabbar__icon` 的话，把 `.tabbar__pub`
 * 单独改大（稿子本来画的是 68px）测试仍会全绿，而底栏顶边已经压到回顶钮上。
 *
 * 文字行高同理：`font-size` 继承自 `.tabbar__tab`，但 `.tabbar__label` 允许自己覆盖，
 * 所以取「自己声明优先、否则继承」。
 *
 * 栏体的 `box-sizing` 是 content-box —— 页面级 `border-box` 只写在 `.page` 上
 * （`app.scss`），`.tabbar` 是挂在 `<page>` 之外的组件。
 */
async function tabBarGeometry(): Promise<{ bottom: number; height: number }> {
  const style = await Bun.file(new URL('../src/custom-tab-bar/index.scss', import.meta.url)).text()
  const bar = ruleBody(style, '.tabbar')
  const tab = ruleBody(style, '.tabbar__tab')
  const label = ruleBody(style, '.tabbar__label')

  const borderWidth = px(bar, 'border')
  const padding = /padding:\s*([\d.]+)px\s+[\d.]+px\s+([\d.]+)px/.exec(bar)
  expect(padding, '.tabbar 的 padding 不是三段式').not.toBeNull()
  const paddingY = Number(padding?.[1]) + Number(padding?.[2])

  const iconColumn = px(ruleBody(style, '.tabbar__icon'), 'height')
  const pubColumn = px(ruleBody(style, '.tabbar__pub'), 'height')
  const gap = px(tab, 'gap')
  const fontSize = pxOrNull(label, 'font-size') ?? px(tab, 'font-size')
  const lineHeight = Number(/line-height:\s*([\d.]+)\s*;/.exec(label)?.[1])
  expect(lineHeight, '.tabbar__label 没有可解析的 line-height').toBeGreaterThan(0)

  return {
    bottom: px(bar, 'bottom'),
    height:
      borderWidth * 2 + paddingY + Math.max(iconColumn, pubColumn) + gap + fontSize * lineHeight,
  }
}

/** 回顶钮底边与悬浮层顶边之间留的缝（设计约定 16rpx = 8pt） */
const TAB_GAP = 16

describe('回顶钮 bottom：Tab 页避让底栏', () => {
  test('底栏几何自证（算出来正好是文档里的 154rpx 顶边）', async () => {
    const bar = await tabBarGeometry()
    expect(bar.bottom).toBe(53)
    // 栏高 101rpx：与 `custom-tab-bar/index.scss` 的注释、各页 padding-bottom 口径一致
    expect(bar.height).toBeCloseTo(101, 1)
    expect(bar.bottom + bar.height).toBeCloseTo(154, 1)
  })

  for (const file of ['home/index.tsx', 'chat/index.tsx', 'wish/index.tsx']) {
    test(`${file} 抬到底栏顶边之上（顶边 + ${TAB_GAP}rpx 缝）`, async () => {
      const bar = await tabBarGeometry()
      // 底栏挪位、这里没跟着改 —— 就是 145rpx 变成存量错的那次（#237 按更早的底栏位置算的值）
      expect(await backTopBottom(file)).toBe(Math.round(bar.bottom + bar.height + TAB_GAP))
    })
  }
})

describe('回顶钮 bottom：mylist 按本页 FAB 定位', () => {
  test('mylist 不是 Tab 页 —— app.config.ts 的 tabBar 里没有它', async () => {
    const config = await Bun.file(new URL('../src/app.config.ts', import.meta.url)).text()
    const list = config.slice(config.indexOf('list: ['))
    const paths = [...list.matchAll(/pagePath: '([^']+)'/g)].map((m) => m[1])
    expect(paths).toEqual([
      'pages/home/index',
      'pages/wish/index',
      'pages/sell/index',
      'pages/chat/index',
      'pages/profile/index',
    ])
    expect(paths).not.toContain('pkg-browse/pages/mylist/index')
  })

  test('避让的是本页 `.ml__fab`：fab 距底 + fab 高 + 40rpx 缝', async () => {
    const style = await Bun.file(
      new URL('../src/pkg-browse/pages/mylist/index.scss', import.meta.url),
    ).text()
    const fab = ruleBody(style, '.ml__fab')
    // 稿 `.totop` 的缝是 `var(--fab-b) + var(--fab-h) + 20px`，按本仓「pt × 2」= 40px
    const expected = px(fab, 'bottom') + px(fab, 'height') + 40
    expect(await backTopBottom('pkg-browse/pages/mylist/index.tsx')).toBe(expected)
    // 底栏顶边（154）与本页无关：套过去会把按钮压到发布钮上
    const bar = await tabBarGeometry()
    expect(expected).not.toBe(Math.round(bar.bottom + bar.height + TAB_GAP))
  })
})

describe('回顶钮 bottom 文档口径', () => {
  test('组件注释写明 Tab 页与「自带悬浮钮的页面」是两套取值', async () => {
    const source = await Bun.file(
      new URL('../src/components/back-top/index.tsx', import.meta.url),
    ).text()
    // 不写明的话，下一个人又会像 #319 第一版那样去「统一」它们
    expect(source).toContain("'170rpx'")
    expect(source).toContain("'188rpx'")
    expect(source).toContain('mylist')
  })

  test('注释把 145rpx 的来历写成「#237 接入时按旧底栏算的」，不是「#235 漏改」', async () => {
    const source = await Bun.file(
      new URL('../src/components/back-top/index.tsx', import.meta.url),
    ).text()
    /**
     * 事实（`git log -S` / `git cat-file` 可查）：`back-top` 组件在 #235（ad1b3e6）时
     * **还不存在**，145rpx 是 #237（2878bbb）随组件接入 main 的。所以不是「#235 漏同步
     * 传值」—— #235 时根本没有传值可同步 —— 而是「#237 接入时按 #235 之前的底栏位置
     * （距底 32px、顶边 133rpx）算了 145rpx，落盘时那个位置已经被 #235 挪走了」。
     * 归因错了会让后来人按「#235 漏改」去找别处的漏改点，白跑一趟。
     *
     * 断言**实质**（那三个具体数字）而不只是措辞：只查 `#237` 在不在的话，一句
     * 「#237 时漏同步了 #235 的底栏」也能过，而那正是要防的错。
     */
    expect(source).toContain('#237')
    expect(source).toContain('2878bbb')
    expect(source).toContain('bottom: 32px')
    expect(source).toContain('133rpx')
    expect(source).not.toContain('漏同步')
    expect(source).not.toContain('漏改')
  })
})
