import { describe, expect, test } from 'bun:test'

/**
 * 会话页「+」面板的点外部收起（#541 + #597）。
 *
 * #541 的做法是一层透明遮罩，代价是**面板展开期间消息流滑不动**（遮罩吃掉整片触摸），
 * 这正是 #597 现象二。现在改由消息流自己的 `onTouchStart` 收起面板：触摸先落到 ScrollView
 * 上，滚动照旧，手指一动就收面板。
 *
 * 所以这里钉三件事：**遮罩彻底没了**、**收起挂在消息流的 `onTouchStart` 上且只在展开时挂**、
 * **面板不再夹在消息流与输入栏之间**（它是底部底座里的吸底浮层）。
 *
 * 本仓 `tests/` 没有 Taro 组件渲染基建，页面接线只能读源码钉住（先例
 * `tests/back-top-scroll-source.test.ts`）：断言切到具体片段再查。
 */

const pageUrl = new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)
const styleUrl = new URL('../src/pkg-social/pages/conversation/index.scss', import.meta.url)

async function pageSource(): Promise<string> {
  return await Bun.file(pageUrl).text()
}

async function styleSource(): Promise<string> {
  return await Bun.file(styleUrl).text()
}

/** 去掉注释再空白归一：注释里出现的标识符不算实现（先例 back-top-scroll-source.test.ts）。 */
function squash(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

/** 切出一个标签：从 `needle` 起到它自己的 `>`（跳过 `=>` 里的 `>`）。 */
function tag(source: string, needle: string): string {
  const start = source.indexOf(needle)
  if (start < 0) throw new Error(`找不到片段：${needle}`)
  let end = source.indexOf('>', start)
  while (end > 0 && source[end - 1] === '=') end = source.indexOf('>', end + 1)
  return source.slice(start, end + 1)
}

/** 切出一个 CSS 规则块（扁平选择器，块内无嵌套）。 */
function styleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`找不到样式块：${selector}`)
  const close = css.indexOf('}', start)
  return css.slice(start, close + 1)
}

describe('会话页「+」面板点外部收起（#541/#597）', () => {
  test('不再有遮罩：源码与样式里都不许出现那层吃触摸的浮层', async () => {
    expect(await pageSource()).not.toContain('conv__panel-mask')
    expect(await styleSource()).not.toContain('conv__panel-mask')
    // 遮罩的定位锚点（导航行底边）一并退场，别留下「没用的内联 top」
    expect(squash(await pageSource())).not.toContain('top: `$' + '{metrics.totalHeight}px`')
  })

  test('收起挂在消息流的 onTouchStart 上，且只在展开时挂', async () => {
    const scroll = tag(squash(await pageSource()), '<ScrollView')
    expect(scroll).toContain('className="conv__scroll"')
    expect(scroll).toContain('onTouchStart={panelOpen ? dismissPanel : undefined}')
    // 收起态传 undefined，回调不进事件表（否则整个会话都在走这一层事件）
    expect(scroll).not.toContain('onTouchStart={dismissPanel}')
    /**
     * 消息流不许被锁：面板展开期间它必须还能滚（#597 现象二）。
     * Taro 的 ScrollView 一旦带上 `catchMove` / `disableScroll`，触摸就被容器自己吃掉。
     */
    expect(scroll).not.toContain('catchMove')
    expect(scroll).not.toContain('disableScroll')
    expect(scroll).toContain('scrollY')
  })

  test('导航行与状态栏仍然点一下就收面板', async () => {
    const head = tag(squash(await pageSource()), '<View className="conv__head"')
    expect(head).toContain('onClick={panelOpen ? dismissPanel : undefined}')
  })

  test('收起只收面板：不碰已输入文字、不 blur 输入框', async () => {
    // 滚动位置交给与「再点 +」同一个贴底守卫决定（贴底的仍贴底、翻历史的原地不动 —— #561）
    const dismiss = squash(await pageSource())
    const body = dismiss.slice(dismiss.indexOf('const dismissPanel = () => {'))
    expect(body.slice(0, body.indexOf('}'))).toContain('setPanelOpen(false)')
    expect(body.slice(0, body.indexOf('}'))).not.toContain('setInputValue')
  })

  test('点面板里的格子收起面板后同样重指尾行（相册/相机被取消时位置已经落对）', async () => {
    const source = squash(await pageSource())
    const body = source.slice(source.indexOf('const panelAction = ('))
    const head = body.slice(0, body.indexOf('if (key === '))
    expect(head).toContain('keepTailAnchored()')
    expect(head).toContain('setPanelOpen(false)')
    // 先落位置再跳转：反过来的话，用户在相册里点取消回来，页面已经空了半屏却没重锚
    expect(head.indexOf('keepTailAnchored()')).toBeLessThan(head.indexOf('setPanelOpen(false)'))
  })

  test('面板不再夹在消息流与输入栏之间：它是底部底座里的吸底浮层', async () => {
    const css = await styleSource()
    const panel = styleBlock(css, '.conv__panel')
    expect(panel).toContain('position: absolute')
    expect(panel).toContain('bottom: 0')
    // 定位父级是底部底座（输入栏那一层），不是整页 `.conv` —— 落在 `.conv` 上就会盖住消息流，
    // 也就是 #597 现象二的另一种形态（看似收起面板，其实是把消息流挡在一层浮层下面）
    expect(styleBlock(css, '.conv__bottom')).toContain('position: relative')
    // 消息流自身的层级与滚动能力不变
    const scroll = styleBlock(css, '.conv__scroll')
    expect(scroll).toContain('z-index: 1')
    expect(scroll).toContain('flex: 1')
    // 输入栏仍在面板之上那一层：底座整块 20，面板是它的子元素，同层不受夹
    expect(styleBlock(css, '.conv__bottom')).toContain('z-index: 20')
    /**
     * 面板要压过输入栏一格：`.conv__bar` 是不透明的（`background: var(--surface)`）且自己
     * 带 `z-index: 20`，盒子连内边距一起铺满整个底座 —— 面板与它同层或更低就会被那层底色
     * 整个盖住，端上看起来是「点了 + 什么都不出来」。
     */
    expect(panel).toContain('z-index: 21')
  })

  test('既有的两条收起路径与语音互斥不变', async () => {
    const source = squash(await pageSource())
    expect(source).toContain('const togglePanel = () => {')
    // 聚焦输入框仍然收起面板；`onFocus` 现在是块体（顺带作废收尾尾巴窗口与意图闩，#560）
    expect(source).toContain('onFocus={() => {')
    expect(source).toContain('setPanelOpen(false)')
    // 开面板退回键盘态的互斥规则（abortRecording + setVoiceMode(false)）仍在 togglePanel 里
    const toggleAt = source.indexOf('const togglePanel = () => {')
    const setterAt = source.indexOf('setPanelOpen(!panelOpen)', toggleAt)
    // 「+」必须真的切换面板状态：少了这一句按钮就再也开关不了面板；而且截取范围的
    // 结束位置会退化成 -1（切到文件末尾），让下面两条互斥断言在空实现上误绿
    expect(setterAt).toBeGreaterThan(toggleAt)
    const toggleBody = source.slice(toggleAt, setterAt)
    // 互斥调用必须挂在「打开面板」分支上：条件反转（关闭时才 abortRecording）同样是回归
    expect(toggleBody).toContain('if (!panelOpen) {')
    expect(toggleBody).toContain('abortRecording()')
    expect(toggleBody).toContain('setVoiceMode(false)')
  })
})
