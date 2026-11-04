import { describe, expect, test } from 'bun:test'
import {
  BAR_GAP_RPX,
  resolveBottomInset,
  resolveBottomReserveStyles,
} from '../src/pkg-social/pages/conversation/view'

/**
 * 会话页底部底座的几何口径（#577）。
 *
 * 改前这套数字散在四处：三颗钮各写一遍 68、输入框自己再写一遍 68、176 只写在输入框上、
 * 安全区写在 `.conv__bar` 的下内边距里（`calc(16px + env(...))`）。于是「统一 68」靠的是
 * 每处都没被单独改过，「安全区只算一次」靠的是没人再补一层 —— 谁碰一处就再也不对齐。
 *
 * 现在口径收敛成两层：
 * - **数值**在 scss 顶部的三个 token 里（`$bar-control-px` / `$bar-gap-px` / `$bar-input-max-px`），
 *   四个控件只引用 token；
 * - **占用态的两个内联值**在 `view.ts` 的 `resolveBottomReserveStyles()` 里（纯函数，可表驱动）。
 *
 * 布局本身（矩形、真机三端）单测冒充不了，见 `apps/miniapp/docs/conversation-bottom-bar.md`
 * 的测量清单。这里钉的是「口径」（谁拥有安全区、四个控件是不是同一个数），不是像素。
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

/** 切出一个片段：从 `from` 起到第一个 `to`。 */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  if (start < 0) throw new Error(`找不到片段：${from}`)
  const end = source.indexOf(to, start)
  if (end < 0) throw new Error(`找不到结尾：${to}`)
  return source.slice(start, end)
}

describe('底座让高的纯函数（#577）', () => {
  const idleInset = [0, -1, Number.NaN]

  test('收起态整段不内联：安全区交给 scss，不能返回 0px', () => {
    // 返回 `{ paddingBottom: '0px' }` 就等价于「收起时把安全区清零」——
    // 底栏会贴到窗口底边、home indicator 直接压在输入行上
    for (const bottomInset of idleInset) {
      const style = resolveBottomReserveStyles(bottomInset)
      expect(style.bottom).toBeUndefined()
      expect(style.bar).toBeUndefined()
    }
  })

  test('占用态：底座安全区清零，输入栏下内边距 = 占位 + 基础间距', () => {
    const style = resolveBottomReserveStyles(280)
    expect(style.bottom).toEqual({ paddingBottom: '0px' })
    expect(style.bar).toEqual({ paddingBottom: 'calc(280px + 16rpx)' })
  })

  test('占用态不叠安全区：内联值里不出现 env（键盘高度已经盖住了 home indicator）', () => {
    for (const bottomInset of [236, 280, 300]) {
      const style = resolveBottomReserveStyles(bottomInset)
      expect(style.bottom?.paddingBottom).not.toContain('env(')
      expect(style.bar?.paddingBottom).not.toContain('env(')
    }
  })

  test('基础间距与 scss 的 $bar-gap-px 是同一个数（1px = 1rpx）', async () => {
    const style = squash(await styleSource())
    const token = slice(style, '$bar-gap-px:', ';').replace(/[^\d]/g, '')
    expect(Number(token)).toBe(BAR_GAP_RPX)
    // 输入栏下内边距的内联值必须是同一个 token 的数，不能是另拍一个
    expect(resolveBottomReserveStyles(200).bar?.paddingBottom).toContain(`${BAR_GAP_RPX}rpx`)
  })

  test('让高样式只由占位高度决定：同一个占位就是同一份样式（与谁占用无关）', () => {
    /**
     * #597 追加任务之后「面板高 == 键盘高」不再成立（面板按内容撑开），所以这里不再断言
     * 键盘态与面板态等高 —— 那条等式被有意的取舍取代了：面板 → 键盘的交接会让底座**一次**
     * 变高（差一个「键盘高 − 面板高」）。本条钉的是本函数自己的契约：输出只由 `bottomInset`
     * 决定，同一个占位高度永远给同一份内联样式，页面两条分支共用它、不会各自漂。
     */
    const keyboardUp = resolveBottomInset({
      panelOpen: false,
      keyboardHeight: 280,
      panelHeight: 97,
    })
    const panelOpen = resolveBottomInset({ panelOpen: true, keyboardHeight: 0, panelHeight: 97 })
    expect(keyboardUp).toBe(280)
    expect(panelOpen).toBe(97)
    expect(resolveBottomReserveStyles(keyboardUp)).toEqual(resolveBottomReserveStyles(280))
    expect(resolveBottomReserveStyles(panelOpen)).toEqual(resolveBottomReserveStyles(97))
    // 交接那一次底座变高 = 键盘高 − 面板高（本单的预期行为，不是两拍）
    expect(keyboardUp - panelOpen).toBe(183)
  })

  test('占位越大，让出的下内边距越大（单调，不出现反向两拍）', () => {
    const pad = (bottomInset: number) =>
      Number(
        /calc\((\d+(?:\.\d+)?)px/.exec(
          resolveBottomReserveStyles(bottomInset).bar?.paddingBottom ?? '',
        )?.[1],
      )
    const insets = [16, 60, 180, 236, 280, 300]
    const pads = insets.map(pad)
    for (let i = 1; i < pads.length; i += 1) {
      expect(pads[i]).toBeGreaterThan(pads[i - 1])
    }
  })
})

describe('输入栏几何的数值真源（#577）', () => {
  test('三个 token 存在，值就是设计稿的 68 / 16 / 176', async () => {
    const style = squash(await styleSource())
    expect(style).toContain('$bar-control-px: 68px;')
    expect(style).toContain('$bar-gap-px: 16px;')
    expect(style).toContain('$bar-input-max-px: 176px;')
    // 除 token 行外不许再出现裸 68/176（注释在 squash 里已被剥掉，剩下的都是声明）
    expect(style.match(/68px/g)?.length).toBe(1)
    expect(style.match(/176px/g)?.length).toBe(1)
  })

  test('四个控件同一个控件高：语音、加号、发送、输入框', async () => {
    const style = squash(await styleSource())
    const cbtn = slice(style, '.conv__cbtn {', '}')
    expect(cbtn).toContain('width: $bar-control-px')
    expect(cbtn).toContain('height: $bar-control-px')
    const plus = slice(style, '.conv__plus {', '}')
    expect(plus).toContain('width: $bar-control-px')
    expect(plus).toContain('height: $bar-control-px')
    expect(slice(style, '.conv__send {', '}')).toContain('height: $bar-control-px')
    expect(slice(style, '.conv__input {', '}')).toContain('min-height: $bar-control-px')
  })

  test('输入框：上限 176、上下内边距由「控件高 − 行高」推导（单行盒高恒等于控件高）', async () => {
    const style = squash(await styleSource())
    // 切到规则末尾（`}` 不行：`#{$bar-control-px}` 自带一个花括号）
    const input = slice(style, '.conv__input {', 'color: var(--fg)')
    expect(input).toContain('max-height: $bar-input-max-px')
    expect(input).toContain('padding: calc((#{$bar-control-px} - 1.4em) / 2) 24px')
    // 推导式里的 1.4em 必须与同一规则的 line-height 同一个数，否则单行盒高又会差一截
    expect(input).toContain('line-height: 1.4')
  })

  test('多行时按钮底对齐、不被拉伸', async () => {
    const style = squash(await styleSource())
    expect(slice(style, '.conv__bar-row {', '}')).toContain('align-items: flex-end')
  })

  test('输入行上下基础间距都用 $bar-gap-px，输入栏自身不写安全区', async () => {
    const style = squash(await styleSource())
    const bar = slice(style, '.conv__bar {', '}')
    expect(bar).toContain('padding: $bar-gap-px 24px')
    expect(bar).not.toContain('env(safe-area-inset-bottom)')
  })

  test('安全区归底座：.conv__bottom 有 env + 底栏底色，键盘/面板态由内联清零', async () => {
    const style = squash(await styleSource())
    const bottom = slice(style, '.conv__bottom {', '}')
    expect(bottom).toContain('padding-bottom: env(safe-area-inset-bottom)')
    expect(bottom).toContain('background: var(--surface)')
    expect(bottom).toContain('position: relative')
    expect(bottom).toContain('flex: 0 0 auto')
    // 面板态：占用者是面板自己，它的下内边距带环境底线（此时底座那份已被清零）
    expect(slice(style, '.conv__panel {', '}')).toContain(
      'padding: 24px 28px calc(24px + env(safe-area-inset-bottom))',
    )
  })

  test('页面里没有第三处安全区（env 只出现在上面两个归属地）', async () => {
    const style = squash(await styleSource())
    expect(style.match(/env\(safe-area-inset-bottom\)/g)?.length).toBe(2)
    // 页面不得自己拼内联安全区（内联只来自 resolveBottomReserveStyles）
    expect(squash(await pageSource())).not.toContain('env(safe-area-inset-bottom)')
  })
})

describe('底座的接线（#577）', () => {
  test('底座是弹列最后一个孩子、在消息流之后，输入栏是它的孩子', async () => {
    const source = squash(await pageSource())
    const scrollEnd = source.indexOf('</ScrollView>')
    const bottom = source.indexOf('<View className="conv__bottom"')
    expect(scrollEnd).toBeGreaterThan(0)
    expect(bottom).toBeGreaterThan(scrollEnd)
    // 输入栏必须在底座里面（底座负责贴底与安全区，输入栏只负责自己那圈内边距）
    expect(source.indexOf('<View className="conv__bar"')).toBeGreaterThan(bottom)
  })

  // 变异守卫（审查 M4）：删掉任一处 `style={...}` 接线，结算出来的样式就再也没人用 —— 纯函数单测不会红，只能在这里抓
  test('两处内联都接到同一个派生结果上', async () => {
    const source = squash(await pageSource())
    expect(source).toContain('const bottomReserve = resolveBottomReserveStyles(bottomInset)')
    const bottomAt = source.indexOf('<View className="conv__bottom"')
    expect(source.slice(bottomAt, bottomAt + 200)).toContain('style={bottomReserve.bottom}')
    const barAt = source.indexOf('<View className="conv__bar"')
    expect(source.slice(barAt, barAt + 200)).toContain('style={bottomReserve.bar}')
  })
})
