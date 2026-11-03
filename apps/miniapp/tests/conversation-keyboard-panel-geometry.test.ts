import { describe, expect, test } from 'bun:test'
import { BOTTOM_SLACK_PX, isNearBottom } from '../src/pkg-social/pages/conversation/view'

/**
 * 会话页输入栏 / 消息流的几何（#560、#561）。
 *
 * 两票是同一套时序：输入栏是 100vh 弹性列的最后一个流内块、消息流是它上面那条 `flex: 1`
 * 的 ScrollView，所以**任何**让输入栏变高/变矮的动作（键盘升降、面板开合、语音态切换）
 * 都会同时改变消息流的可视高度。改前它们分几帧落地：先长高再长高一次 → 输入栏「先上提
 * 再回落」；消息流连着变矮 → 原生层把越界的滚动偏移截断/归零后无人重指尾行 → 「跳回顶部
 * 再错位抽搐」。
 *
 * 本仓 `tests/` 没有 Taro 组件渲染基建，页面接线只能读源码钉住（先例
 * `tests/back-top-scroll-source.test.ts`）：断言**切到具体片段**再查，整份文件的子串命中
 * 挡不住「属性挂到了别的 Textarea / 判据被删回去」这类改法。
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

/** 切出一个函数体：从 `from` 起到 `to`（`to` 不在其前时抛错）。 */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  if (start < 0) throw new Error(`找不到片段：${from}`)
  const end = source.indexOf(to, start)
  if (end < 0) throw new Error(`找不到结尾：${to}`)
  return source.slice(start, end)
}

describe('贴底判据（#561）', () => {
  test('底部差在容差内算贴底，差得远算没贴底', () => {
    // 底部完全对齐
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 1000, viewportHeight: 600 })).toBe(true)
    // 差一点点（输入框长高几 px / iOS 取整）：仍算贴底
    expect(
      isNearBottom({ scrollTop: 400 - BOTTOM_SLACK_PX, scrollHeight: 1000, viewportHeight: 600 }),
    ).toBe(true)
    // 往上翻了一大段：不算贴底，几何变化时不许把人拽回底部
    expect(
      isNearBottom({
        scrollTop: 400 - BOTTOM_SLACK_PX - 1,
        scrollHeight: 1000,
        viewportHeight: 600,
      }),
    ).toBe(false)
  })

  test('内容不足一屏时恒贴底', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, viewportHeight: 600 })).toBe(true)
  })

  test('视口还没量到按贴底处理：宁可多滚一次到底，也不把偏移丢掉', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 2000, viewportHeight: 0 })).toBe(true)
  })
})

describe('键盘高度是单一真源（#560）', () => {
  test('页面订阅设备级键盘高度事件，并在卸载时收回', async () => {
    const source = squash(await pageSource())
    const body = slice(source, 'const onHeightChange =', 'Taro.onKeyboardHeightChange')
    expect(body).toContain('setKeyboardHeight(res.height > 0 ? res.height : 0)')
    expect(source).toContain('Taro.onKeyboardHeightChange(onHeightChange)')
    expect(source).toContain('Taro.offKeyboardHeightChange(onHeightChange)')
  })

  test('输入栏的下内边距由真源派生，收起时不内联（env 安全区照旧生效）', async () => {
    const source = squash(await pageSource())
    // 标签跨多行、`style` 里还有比较运算符，`tag()` 切不准：切到下一个子节点为止
    const bar = slice(source, '<View className="conv__bar"', '{recording ?')
    // 页面里写的字面量就是这个表达式（`${` 拆成两段拼，免得被当成模板串插值）
    const derived =
      'keyboardHeight > 0 ? { paddingBottom: `calc($' + '{keyboardHeight}px + 16rpx)` } : undefined'
    expect(bar).toContain(derived)
    // 键盘收起时不内联，样式里那条带 safe-area 的内边距照旧生效
    expect(await styleSource()).toContain(
      'padding: 16px 24px calc(16px + env(safe-area-inset-bottom))',
    )
  })

  test('输入框不再让平台自己推页面（两套补偿叠加就是抽搐的来源）', async () => {
    const textarea = tag(squash(await pageSource()), '<Textarea')
    expect(textarea).toContain('className="conv__input"')
    expect(textarea).toContain('adjustPosition={false}')
    expect(textarea).toContain('cursorSpacing={0}')
  })

  test('切语音态时在点击当下同步收键盘、真源归零，不等隐私授权查询回来', async () => {
    const body = slice(
      squash(await pageSource()),
      'const toggleVoiceMode = async',
      'setVoiceMode(true)',
    )
    const hideAt = body.indexOf('Taro.hideKeyboard()')
    const zeroAt = body.indexOf('setKeyboardHeight(0)')
    const gateAt = body.indexOf('getPrivacyAuthorizationState()')
    expect(hideAt).toBeGreaterThan(-1)
    expect(zeroAt).toBeGreaterThan(-1)
    // 收键盘、归零都在 await 之前：状态切换不许落在键盘收起的动画窗口里
    expect(hideAt).toBeLessThan(gateAt)
    expect(zeroAt).toBeLessThan(gateAt)
    // 隐私授权的判据本身不变（仍由 canEnterVoiceMode 决定是否落地语音态）
    expect(body).toContain(
      'canEnterVoiceMode(state, seq, voiceGateSeqRef.current, aliveRef.current)',
    )
  })
})

describe('「+」面板与贴底（#561）', () => {
  test('开面板前先收键盘，且收键盘 / 归零 / 重指尾行 / 开面板同批落地', async () => {
    const body = slice(
      squash(await pageSource()),
      'const togglePanel = () => {',
      'setPanelOpen(!panelOpen)',
    )
    const hideAt = body.indexOf('Taro.hideKeyboard()')
    const zeroAt = body.indexOf('setKeyboardHeight(0)')
    const anchorAt = body.indexOf('keepTailAnchored()')
    expect(hideAt).toBeGreaterThan(-1)
    expect(zeroAt).toBeGreaterThan(hideAt)
    expect(anchorAt).toBeGreaterThan(zeroAt)
  })

  test('贴底才重指尾行，翻历史时不许动滚动位置', async () => {
    const body = slice(
      squash(await pageSource()),
      'const keepTailAnchored = useCallback',
      'setTailAnchorFlip',
    )
    expect(body).toContain('if (!stickBottomRef.current) return')
  })

  test('消息流有 onScroll，并把 scrollTop/scrollHeight/视口高度喂给贴底判据', async () => {
    const source = squash(await pageSource())
    expect(tag(source, '<ScrollView')).toContain('onScroll={onScroll}')
    const body = slice(source, 'const onScroll = useCallback', '[]')
    expect(body).toContain('scrollTop')
    expect(body).toContain('scrollHeight')
    expect(body).toContain('viewportHeight: scrollViewportRef.current')
    expect(body).toContain('isNearBottom(')
  })

  test('尾行锚点带 keyId 且能交替：内容追加与几何变化都能重新滚到底', async () => {
    const source = squash(await pageSource())
    // `${` 拆成两段拼，免得被当成模板串插值
    expect(source).toContain(
      'const tailAnchorId = tail ? `conv-tail-$' +
        '{tail.keyId}-$' +
        "{tailAnchorFlip ? 'b' : 'a'}` : ''",
    )
    expect(source).toContain(
      'const scrollTarget = jumpTo && jumpTo.tail === tailId ? jumpTo.id : tailAnchorId',
    )
    // 锚点挂在 ScrollView 里、消息流最末（零尺寸，滚到它就是滚到底）
    expect(source).toContain('{tailAnchorId ? <View id={tailAnchorId} /> : null}')
  })
})
