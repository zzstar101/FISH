/**
 * 会话页交易进度卡的接线（#521 / #522）。
 *
 * 本仓 `apps/miniapp/tests/` 没有 Taro 组件渲染基建（页面用真 `@tarojs/taro` 加载会抛
 * `ENABLE_INNER_HTML is not defined`，见 `tests/conversation-unread-wiring.test.ts` 文件头），
 * 页面接线只能读源码文本钉住 —— 手法同 `tests/conversation-realtime-wiring.test.ts`。
 *
 * 判据层（卡片五态 / 降级 / 取消后新提案收起）由 `tests/conversation-view.test.ts` 覆盖；
 * 本文件钉的是页面有没有把这几条**接线**接对：
 * - 进页 / 返回 / 补刷时按会话查交易（不带 id 的旧入口已删）；
 * - 停留在页面时，PENDING_MEETUP 的进度靠详情轮询顺带刷新（契约没有交易推送）；
 * - 实时 `tx.accepted` 补刷一次（交易行可能比消息晚落库）；
 * - 失败交给 `txCardView` 渲染成「状态待更新」，不复用旧 `tx`；
 * - 卡片的两种 CTA（打开 / 就地重试）都接到了。
 */
import { describe, expect, test } from 'bun:test'

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('#521 / #522 会话页交易进度卡 · 接线', () => {
  test('每次 load 都按会话查交易，并把首屏 tx.accepted 的 id 作为精确查询的首选', async () => {
    const code = await source()
    expect(code).toContain('fetchConversationTransaction(')
    expect(code).toContain('lastTxAcceptedId(page.items)')
    expect(code).not.toContain('/pkg-trade/pages/transaction-meetup/index')
  })

  test('停留在页面时靠详情轮询刷新：PENDING 按 id 查详情，失败则自动重试整份查询', async () => {
    const code = await source()
    const poll = sliceFrom(code, 'timer = setInterval(', 'presenceSeq.current += 1')
    expect(poll).toContain('txLoadRef.current')
    expect(poll).toContain("txState.status === 'failed'")
    // 重试也要带消息里的 id：列表被 500 条上限截断时，只有精确查询能把卡找回来
    expect(poll).toContain('fetchConversationTransaction(')
    expect(poll).toContain('lastTxAcceptedId(messagesRef.current)')
    expect(poll).toContain("txState.tx?.status === 'PENDING_MEETUP'")
    expect(poll).toContain('fetchTransaction(txState.tx.id)')
    // 轮询失败也要记进状态，别把缓存里的 PENDING 当「刚读到的最新进度」
    expect(poll).toContain("setTxLoad((prev) => ({ status: 'failed', tx: prev.tx }))")
  })

  test('实时 tx.accepted 补刷一次会话（交易行可能晚于消息落库）', async () => {
    const code = await source()
    const dispatch = sliceFrom(code, 'realtimeEventRef.current = (event) => {', "case 'media.new'")
    expect(dispatch).toContain("parseTxEvent(event.message.content)?.type === 'tx.accepted'")
    expect(dispatch).toContain('realtimeOpenRef.current()')
  })

  test('查询失败时不信旧终态：只有同一笔 PENDING 缓存能退回成交前文案，其余走 failed', async () => {
    const code = await source()
    // 失败时缓存必须与消息里的交易 id 对得上（别的交易的缓存不能当现状）
    expect(code).toContain('fallbackTxId === txLoad.tx.id')
    expect(code).toContain('txCardView(txFailed ? cachedTx : txLoad.tx, fallbackTxId')
    expect(code).toContain('failed: txFailed')
    // 失败但缓存是 PENDING：文案退回「待面交」，CTA 仍是重试（在 view.ts 里由 failed 决定）
    expect(code).toContain("txLoad.status === 'failed' && txKnown")
  })

  test('交易请求 latest-wins：迟到的旧响应不能覆盖新状态', async () => {
    const code = await source()
    expect(code).toContain('const txSeqRef = useRef(0)')
    // 三条请求路径（进页 load / 20s 轮询 / 失败重试）各自取号
    const takes = code.match(/const txSeq = \+\+txSeqRef\.current/g) ?? []
    expect(takes.length).toBeGreaterThanOrEqual(3)
    const guards = code.match(/txSeq !== txSeqRef\.current/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(3)
  })

  test('取消后新提案的判据来自消息流（详情里的 lastMessage 会滞后）', async () => {
    const code = await source()
    expect(code).toContain('lastEventOfMessages(messages)?.type')
  })

  test('历史 tx.accepted 仍能定位到本笔（同一会话多笔交易不串单）', async () => {
    const code = await source()
    expect(code).toContain("event?.type === 'tx.accepted'")
    expect(code).toContain('txId !== txLoad.tx.id')
    // 查不到当前交易行（接口失败 / 数据缺失）时也要保留入口，不能整条变成死文案
    expect(code).toContain('txLoad.tx === null || txId !== txLoad.tx.id')
    expect(code).toContain('已接受交易 · 查看本笔')
    // 光有文案不够：点击必须把这条消息自己的 id 交给 openMeetup
    expect(code).toContain('() => openMeetup(historicalTxId)')
    expect(code).toContain('onClick={')
  })

  test('老数据的 tx.accepted 没带 id 时不让用户白点，明确指到「我的订单」', async () => {
    const code = await source()
    expect(code).toContain('已接受交易 · 请从「我的订单」查看')
    // 这句话本身要能点进订单页，否则只是换个说法让用户自己找
    expect(code).toContain('noIdHint ? goOrders : undefined')
    expect(code).toContain("conversation.role === 'buyer'")
  })

  test('卡片按 CTA 语义分流：retry 就地重查，open 走带 id 的面交页', async () => {
    const code = await source()
    expect(code).toContain('<TxCard')
    expect(code).toContain(
      "txCard.action === 'retry' ? retryTx() : openMeetup(txCard.transactionId)",
    )
  })
})
