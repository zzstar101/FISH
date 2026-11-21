import { describe, expect, test } from 'bun:test'
import { resolveScrollTarget } from '../src/pkg-social/pages/conversation/view'

/**
 * 会话页「向上翻历史时的阅读位置」（#633）。
 *
 * 现象：用户向上翻到更早的消息，这时后台刷新补进一条、或对方发来一条 —— 消息流整个滚回
 * 底部，正在看的位置被丢掉，而他并没有做任何想回底部的动作。
 *
 * 原因不在刷新，在滚动目标的判据：`scrollIntoView` **恒定**指向「尾行锚点」
 * （`conv-tail-<keyId>-<a|b>`），而属性值一变原生层就滚一次底。尾行只要变化（新消息、
 * 待发落定、媒体项从待发改成已发）就拽一次。改法是让尾行锚点只在「用户本来就贴着底」时
 * 才下发，
 * 判据抽成 `./view` 的 `resolveScrollTarget` 按表格验。
 *
 * 本仓 `tests/` 没有 Taro 组件渲染基建，页面接线只能读源码钉住（先例
 * `tests/back-top-scroll-source.test.ts`、`tests/conversation-entry-scroll-animation.test.ts`）：
 * 断言**切到具体片段**再查，整份文件的子串命中挡不住「判据被删回去」这类改法。
 */

const pageUrl = new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)

async function pageSource(): Promise<string> {
  return await Bun.file(pageUrl).text()
}

/** 去掉注释再空白归一：注释里出现的标识符不算实现（先例 back-top-scroll-source.test.ts）。 */
function squash(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

/** 取 `from` 之后到 `to` 之前的源码（两端都不含），先切再 `squash`。 */
async function slice(from: string, to: string): Promise<string> {
  const text = await pageSource()
  const start = text.indexOf(from)
  expect(start, `缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `缺少片段：${to}`).toBeGreaterThan(start)
  return squash(text.slice(start + from.length, end))
}

describe('resolveScrollTarget —— 尾行锚点只在「跟随最新」时下发（#633）', () => {
  const tail = 'conv-tail-e-42-a'

  test('贴着底：指向尾行锚点，新消息照旧跟随到底（#540 的行为不变）', () => {
    expect(resolveScrollTarget({ jumpTarget: null, tailAnchorId: tail, stickToBottom: true })).toBe(
      tail,
    )
  })

  test('翻历史：什么都不指 —— 属性值不变，原生层不重滚，阅读位置留在原地', () => {
    expect(
      resolveScrollTarget({ jumpTarget: null, tailAnchorId: tail, stickToBottom: false }),
    ).toBe('')
  })

  test('摘引跳转优先于贴底判据：翻着历史点摘引照样跳过去（#540）', () => {
    expect(
      resolveScrollTarget({ jumpTarget: 'e-3', tailAnchorId: tail, stickToBottom: false }),
    ).toBe('e-3')
  })

  test('摘引跳转优先于跟随：贴着底点摘引同样跳到被引用那条（#540）', () => {
    expect(
      resolveScrollTarget({ jumpTarget: 'e-3', tailAnchorId: tail, stickToBottom: true }),
    ).toBe('e-3')
  })

  test('空会话（没有尾行）：两种贴底态都不指，与改前一致', () => {
    expect(resolveScrollTarget({ jumpTarget: null, tailAnchorId: '', stickToBottom: true })).toBe(
      '',
    )
    expect(resolveScrollTarget({ jumpTarget: null, tailAnchorId: '', stickToBottom: false })).toBe(
      '',
    )
  })
})

describe('页面接线：翻历史不被拽回底部（#633）', () => {
  test('滚动事件把贴底标志写进渲染态，判据才进得了 scrollIntoView', async () => {
    // 只写 `stickBottomRef` 的话「从贴底翻到翻历史」不重渲染，属性仍指着尾行锚点，
    // 下一条新消息照样把人拽回底部 —— 两处必须同值同写。
    const scroll = await slice('const onScroll = useCallback(', '\n  }, [])')
    // 断言「取到的值先落中间变量再双写」：改前那句 `stickBottomRef.current =
    // stickAfterScroll(nearBottom)` 也含 `stickBottomRef.current = stick` 前缀，
    // 只查前缀的话这条在修复前照样绿。
    expect(scroll).toContain(
      'const stick = stickAfterScroll(nearBottom) stickBottomRef.current = stick',
    )
    expect(scroll).toContain('setStickBottom((prev) => (prev === stick ? prev : stick))')
  })

  test('滚动目标由贴底标志决定，摘引目标与它分开传', async () => {
    const target = await slice('const scrollTarget =', 'const animateScroll =')
    expect(target).toMatch(
      /resolveScrollTarget\(\{ jumpTarget, tailAnchorId, stickToBottom: stickBottom,? \}\)/,
    )
    // 摘引目标按「尾行一变即失效」先归约成 `string | null`，再与贴底判据一起决策
    const jump = await slice('const jumpTarget =', 'const scrollTarget =')
    expect(jump).toContain('jumpTo !== null && jumpTo.tail === tailId ? jumpTo.id : null')
  })

  test('贴底标志的渲染态初值为真：进页第一屏仍停在最新', async () => {
    expect(squash(await pageSource())).toContain(
      'const [stickBottom, setStickBottom] = useState(true)',
    )
  })

  test('换身份把渲染态归位，不沿用上个身份的「翻历史」', async () => {
    const reset = await slice('scrollTopRef.current = 0', 'setScrollRestore(null)')
    expect(reset).toContain('stickBottomRef.current = true')
    expect(reset).toContain('setStickBottom(true)')
  })

  test('用户自己发文本：翻着历史发也要回到尾行', async () => {
    const send = await slice('const send = () => {', '\n  }')
    expect(send).toContain('followAfterSend()')
  })

  test('用户自己发图片 / 语音：同样回到尾行', async () => {
    const media = await slice('const sendMedia = (', '\n  }')
    expect(media).toContain('followAfterSend()')
  })

  test('强制回底同时写 ref 与渲染态，否则下一条消息又会把人拽走', async () => {
    const fn = await slice('const followAfterSend = () => {', '\n  }')
    expect(fn).toContain('stickBottomRef.current = true')
    expect(fn).toContain('setStickBottom(true)')
  })
})
