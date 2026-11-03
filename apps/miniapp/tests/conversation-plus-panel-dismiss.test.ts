import { describe, expect, test } from 'bun:test'

/**
 * 会话页「+」面板的点外部收起（#541）。
 *
 * 现象：面板只能再点一次「+」或聚焦输入框才收，点消息流 / 商品条 / 页面空白没有任何
 * 反应。修法是一层透明遮罩，所以这里钉两件事：**遮罩只在面板展开时挂**、**它的层级
 * 夹在消息流与输入栏之间**（挂错层级就会把输入栏和「+」一起吞掉，或者盖不到消息流）。
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

describe('会话页「+」面板点外部收起（#541）', () => {
  test('遮罩只在面板展开时渲染，点它只收面板', async () => {
    const source = await pageSource()
    const mask = tag(squash(source), '<View className="conv__panel-mask"')
    expect(mask).toContain('onClick={dismissPanel}')
    // 顶边取导航行底边：返回钮不被遮住
    expect(mask).toMatch(/top: `\$\{metrics\.totalHeight\}px`/)
    // 收起只收面板：不碰已输入文字、不 blur 输入框；滚动位置交给与「再点 +」同一个贴底
    // 守卫决定（面板一走消息流就变高，贴底的仍贴底、翻历史的原地不动 —— #561）
    const dismiss = squash(source).slice(squash(source).indexOf('const dismissPanel = () => {'))
    expect(dismiss.slice(0, dismiss.indexOf('}'))).toContain('setPanelOpen(false)')
    expect(dismiss.slice(0, dismiss.indexOf('}'))).not.toContain('setInputValue')
  })

  test('导航行与状态栏带在遮罩之上，点它们也收面板', async () => {
    const head = tag(squash(await pageSource()), '<View className="conv__head"')
    expect(head).toContain('onClick={panelOpen ? dismissPanel : undefined}')
  })

  test('遮罩紧挂在 panelOpen 条件里，收起态不占位、不吃点击', async () => {
    // 条件必须紧挨着遮罩本身：别处出现同名条件不该让这条通过
    expect(squash(await pageSource())).toContain(
      '{panelOpen ? ( <View className="conv__panel-mask"',
    )
  })

  test('遮罩铺满整片空区，层级夹在消息流与输入栏之间', async () => {
    const css = await styleSource()
    const mask = styleBlock(css, '.conv__panel-mask')
    expect(mask).toContain('position: absolute')
    expect(mask).toContain('z-index: 3')
    // 少任一边，遮罩就塌成一条线/半块，「点空白也能收」整条验收就落空
    expect(mask).toContain('left: 0')
    expect(mask).toContain('right: 0')
    expect(mask).toContain('bottom: 0')
    // 绝对定位相对 .conv；这个锚点丢了会改成相对页面定位、可能盖住返回钮
    expect(styleBlock(css, '.conv')).toContain('position: relative')
    // 低于输入栏（20）才点得到「+」和面板本身，高于消息流（1）才盖得住长按与图片预览
    expect(styleBlock(css, '.conv__bar')).toContain('z-index: 20')
    expect(styleBlock(css, '.conv__scroll')).toContain('z-index: 1')
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
