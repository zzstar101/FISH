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

  test('停留在页面时 PENDING_MEETUP 的交易靠详情轮询刷新（服务端没有交易推送）', async () => {
    const code = await source()
    const poll = sliceFrom(code, 'timer = setInterval(', 'presenceSeq.current += 1')
    expect(poll).toContain('txLoadRef.current.tx')
    expect(poll).toContain("pendingTx?.status === 'PENDING_MEETUP'")
    expect(poll).toContain('fetchTransaction(pendingTx.id)')
  })

  test('实时 tx.accepted 补刷一次会话（交易行可能晚于消息落库）', async () => {
    const code = await source()
    const dispatch = sliceFrom(code, 'realtimeEventRef.current = (event) => {', "case 'media.new'")
    expect(dispatch).toContain("parseTxEvent(event.message.content)?.type === 'tx.accepted'")
    expect(dispatch).toContain('realtimeOpenRef.current()')
  })

  test('查询失败时把 null 交给 txCardView 并标 failed，不复用上一份 tx', async () => {
    const code = await source()
    expect(code).toContain("const txFailed = txLoad.status === 'failed' && txKnown")
    expect(code).toContain('txCardView(txFailed ? null : txLoad.tx, fallbackTxId')
    expect(code).toContain('failed: txFailed')
  })

  test('卡片按 CTA 语义分流：retry 就地重查，open 走带 id 的面交页', async () => {
    const code = await source()
    expect(code).toContain('<TxCard')
    expect(code).toContain(
      "txCard.action === 'retry' ? retryTx() : openMeetup(txCard.transactionId)",
    )
  })
})
