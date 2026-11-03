import { describe, expect, test } from 'bun:test'
import {
  BOTTOM_SLACK_PX,
  isNearBottom,
  planScrollFix,
  stickAfterScroll,
} from '../src/pkg-social/pages/conversation/view'

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

  test('本页自己造成的视口缩量按 slack 临时放宽：多行输入后仍算贴底', () => {
    // 输入框从 1 行长到 4 行，视口矮 54pt：滚动事件可能还是「旧 scrollTop + 新 scrollHeight」
    const shrunk = { scrollTop: 400 - 54, scrollHeight: 1000, viewportHeight: 600 }
    // 只有常驻基线（24）时会被判成「翻历史」—— 正是 #560 说的「多行输入后再切更明显」
    expect(isNearBottom(shrunk)).toBe(false)
    // 把本次缩量算进容差后仍算贴底，重锚不会被守卫挡掉
    expect(isNearBottom(shrunk, 54)).toBe(true)
    // 真往上翻了一大段时，再大的 slack 也不能算贴底（否则会把翻历史的人拽回底部）
    expect(isNearBottom({ ...shrunk, scrollTop: 0 }, 54)).toBe(false)
  })
})

describe('贴底标志与偏移回读的判据（#561，纯函数表驱动）', () => {
  test('onScroll 之后贴底标志恒等于「此刻贴底」，不取反', () => {
    // 取反的后果：贴底的人再也回不到底部、翻历史的人被拽回底部，端上只表现为「有时候跳一下」
    expect(stickAfterScroll(true)).toBe(true)
    expect(stickAfterScroll(false)).toBe(false)
  })

  test('偏移没丢 / 丢的那次是正常截断 → 什么都不做', () => {
    // 原本就在顶部（用户自己翻到最早）：下掉是正常截断
    expect(planScrollFix({ prevTop: 0, top: 0, stick: true })).toBe('none')
    // 回读时仍在底部附近：没丢
    expect(planScrollFix({ prevTop: 800, top: 790, stick: true })).toBe('none')
  })

  test('偏移掉回顶部：贴底重指尾行，翻历史把原值写回去', () => {
    // 复现里的形态：几何突变后偏移掉成 0
    expect(planScrollFix({ prevTop: 800, top: 0, stick: true })).toBe('anchor')
    expect(planScrollFix({ prevTop: 800, top: 0, stick: false })).toBe('restore')
    // 只差一个像素也算丢（`top > BOTTOM_SLACK_PX` 才放过），贴底/翻历史两条路都要能走
    expect(planScrollFix({ prevTop: 800, top: BOTTOM_SLACK_PX, stick: false })).toBe('restore')
    expect(planScrollFix({ prevTop: 800, top: BOTTOM_SLACK_PX + 1, stick: false })).toBe('none')
  })
})

describe('键盘高度是单一真源（#560）', () => {
  test('页面订阅设备级键盘高度事件，并在卸载时收回', async () => {
    const source = squash(await pageSource())
    const body = slice(source, 'const onHeightChange =', 'Taro.onKeyboardHeightChange')
    expect(body).toContain('setKeyboardHeight(res.height > 0 ? res.height : 0)')
    expect(source).toContain('Taro.onKeyboardHeightChange(onHeightChange)')
    expect(source).toContain('Taro.offKeyboardHeightChange(onHeightChange)')
    // 基础库 < 2.7.0 没有这个 API：裸调会在挂载时抛 TypeError，整页白屏
    expect(source).toContain(
      "if (typeof Taro.onKeyboardHeightChange !== 'function') return undefined",
    )
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

  test('两态同盒模型：语音态用实测输入行高度顶到同一高度，切态消息流不跳', async () => {
    const source = squash(await pageSource())
    // 输入框每多一行就往回报一次实测高度（设备 px），比在渲染期猜行数准。
    // `tag()` 会在 `onLineChange` 里的 `>` 处截断，切到下一个属性为止
    const textarea = slice(source, '<Textarea', 'onFocus=')
    expect(textarea).toContain('onLineChange=')
    expect(textarea).toContain('writeInputRowPx(height)')
    // 长高的那一刻先把「本页让出的高度」记进贴底容差，再更新真源（顺序反了就等于没记）
    const grownAt = textarea.indexOf('bottomGapAllowanceRef.current = grownBy')
    expect(grownAt).toBeGreaterThan(-1)
    expect(grownAt).toBeLessThan(textarea.indexOf('writeInputRowPx(height)'))
    // 「按住说话」拿同一个值当 `minHeight`：不然多行输入后切语音，消息流会突然长高一大截
    // （`tag()` 同样会在 `inputRowPx > 0` 的 `>` 处截断，切到下一个事件绑定为止）
    const hold = slice(source, '<View className={`conv__hold', 'onTouchStart={startVoice}')
    expect(hold).toContain('minHeight: `$' + '{inputRowPx}px`')
    expect(hold).toContain('inputRowPx > 0')
    // 量不到值时退回 scss 的 68（首帧 / 老基础库不报 onLineChange）
    expect(await styleSource()).toContain('height: 68px')
  })

  test('发送清空输入后，输入行高度真源跟着回落（否则下一轮切语音又把消息流顶矮一截）', async () => {
    const body = slice(squash(await pageSource()), 'const send = () => {', 'doSend(text')
    expect(body).toContain("setInputValue('')")
    expect(body).toContain('setInputRowPx(0)')
    // 同步镜像也要清：留着旧的多行高度，「这次长高多少」会从旧值起算而算成 0
    expect(body).toContain('inputRowPxRef.current = 0')
  })

  test('切语音态：点击当下收键盘，真源归零与切态同批落地（分两帧就是先上提再回落）', async () => {
    const body = slice(
      squash(await pageSource()),
      'const toggleVoiceMode = async',
      'setVoiceMode(true)',
    )
    const hideAt = body.indexOf('Taro.hideKeyboard()')
    const gateAt = body.indexOf('getPrivacyAuthorizationState()')
    expect(hideAt).toBeGreaterThan(-1)
    // 收键盘是纯原生动作，不碰本页布局：点击当拍就发，不等授权那趟 await
    expect(hideAt).toBeLessThan(gateAt)
    // 真源归零是**布局变化**，必须排在 await 之后，与切态那批一起落地（末次归零才是那次）
    const zeroAt = body.lastIndexOf('setKeyboardHeight(0)')
    expect(zeroAt).toBeGreaterThan(gateAt)
    expect(body.indexOf('setPanelOpen(false)', zeroAt)).toBeGreaterThan(zeroAt)
    expect(body.indexOf('keepTailAnchored()')).toBeGreaterThan(-1)
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

  test('贴底才重指尾行；换锚后直接认定贴底，不等一条可能永远不来的滚动事件', async () => {
    const body = slice(squash(await pageSource()), 'const keepTailAnchored = useCallback', '}, [])')
    // 翻历史时不动位置（守卫仍在）
    expect(body).toContain('if (stickBottomRef.current) {')
    expect(body).toContain('setTailAnchorFlip((prev) => !prev)')
    // 换锚之后贴底就是已知事实：`onScroll` 不一定会因程序化滚动而回吐事件
    expect(body).toContain('stickBottomRef.current = true')
  })

  test('几何变化后回读偏移：原生层把偏移丢了就补回来，没丢什么都不做', async () => {
    const body = slice(squash(await pageSource()), 'const keepTailAnchored = useCallback', '}, [])')
    // 用几何变化前的 last-known scrollTop 做比对
    expect(body).toContain('const prevTop = scrollTopRef.current')
    expect(body).toContain("select('.conv__scroll')")
    expect(body).toContain('scrollOffset()')
    // 判据本身在 `view.ts`（表驱动单测在上面），这里只钉「真的调了它、三个入参都对」
    expect(body).toContain('planScrollFix({ prevTop, top, stick: stickBottomRef.current })')
    // 贴底 → 再指一次尾行；翻历史 → 把原偏移写回去
    expect(body).toContain("if (fix === 'anchor')")
    expect(body).toContain("if (fix === 'restore')")
    expect(body).toContain('setScrollRestore(')
    // 回读是异步的：落地时页面可能已经卸载
    expect(body).toContain('if (!aliveRef.current) return')
    // 回读必须**无条件**紧接着换锚执行：外面再套一层 `if (false)` / 提前 return，整段
    // 「偏移丢了就补」就静默失效了，端上表现为「偶尔跳回顶部」，任何单点断言都看不出来
    expect(body).toContain('stickBottomRef.current = true } void Taro.nextTick(() => {')
  })

  test('消息流有 onScroll，并把 scrollTop/scrollHeight/视口高度喂给贴底判据', async () => {
    const source = squash(await pageSource())
    expect(tag(source, '<ScrollView')).toContain('onScroll={onScroll}')
    const body = slice(source, 'const onScroll = useCallback', '}, [])')
    expect(body).toContain('scrollTopRef.current = scrollTop')
    expect(body).toContain('scrollHeight')
    expect(body).toContain('viewportHeight: scrollViewportRef.current')
    expect(body).toContain('isNearBottom(')
    // 本页自己造成的视口缩量算进容差；真到底了归零，免得长期放宽
    expect(body).toContain('Math.max(BOTTOM_SLACK_PX, bottomGapAllowanceRef.current)')
    expect(body).toContain('bottomGapAllowanceRef.current = 0')
    // 标志的取值交给 `view.ts` 的纯函数（表驱动单测在上面），组件里不许自己决断
    expect(body).toContain('stickBottomRef.current = stickAfterScroll(nearBottom)')
  })

  test('首次量测不算「缩量」：视口高度从 ref 的 0 长起来时不能一次性放宽到整屏', async () => {
    const body = slice(squash(await pageSource()), 'const viewport = res?.[0]', 'const inputRow')
    expect(body).toContain('scrollViewportRef.current > 0')
    expect(body).toContain('scrollViewportRef.current - viewport.height')
    // 只认缩量：视口变大不该放宽容差
    expect(body).toContain('bottomGapAllowanceRef.current = Math.max(')
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

  test('两条收面板的路径走同一个重锚守卫，且都不碰输入文字 / 不 blur（#541 契约）', async () => {
    const body = slice(squash(await pageSource()), 'const dismissPanel = () => {', '}')
    expect(body).toContain('keepTailAnchored()')
    expect(body).toContain('setPanelOpen(false)')
    expect(body).not.toContain('setInputValue')
  })

  test('偏移复位只走 scrollTop 属性，靠 0.5px 交替让「同一个位置」也再下发一次', async () => {
    const source = squash(await pageSource())
    expect(tag(source, '<ScrollView')).toContain('scrollTop={restoreScrollTop}')
    expect(source).toContain('restoreScrollTop = scrollRestore')
    expect(source).toContain('scrollRestore.tick % 2 === 0 ? 0 : 0.5')
  })
})
