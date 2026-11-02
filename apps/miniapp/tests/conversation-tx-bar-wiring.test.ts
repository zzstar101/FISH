/**
 * 会话页页头「商品交易状态条」的接线（#551）。
 *
 * 本仓 `apps/miniapp/tests/` 没有 Taro 组件渲染基建（页面用真 `@tarojs/taro` 加载会抛
 * `ENABLE_INNER_HTML is not defined`，见 `tests/conversation-unread-wiring.test.ts` 文件头），
 * 页面接线只能读源码文本钉住 —— 手法同 `tests/conversation-realtime-wiring.test.ts`。
 *
 * 判据层（五档状态 / 角色差异 / 降级 / 取消后新提案）由 `tests/conversation-view.test.ts`
 * 的 `txBarView` 覆盖；本文件钉的是页面有没有把这几条**接线**接对：
 * - 进页 / 返回 / 补刷时按会话查交易，并带上消息里 `tx.accepted` 的 id 走精确查询；
 * - 停留在页面时，PENDING_MEETUP 的进度靠详情轮询顺带刷新（契约没有交易推送）；
 * - 交易状态只由页头一条承载：吸底卡（#521 / #522 的 `tx-card.tsx`）已按 Owner 决策删除；
 * - 五档动作各自接到正确的跳转 / 接口：确认→二次确认 + `acceptTransaction`，
 *   扫码→扫码页，交易码与评价→面交页，失败→就地重查；
 * - 「待评价」靠评价边另行判定（交易域没有评价字段）。
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

describe('#551 会话页页头交易状态条 · 接线', () => {
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
    // 重试也要带消息里的 id：列表被 500 条上限截断时，只有精确查询能把状态找回来
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

  test('查询失败时不信旧终态：只有同一笔 PENDING 缓存能退回成交前文案', async () => {
    const code = await source()
    // 失败时缓存必须与消息里的交易 id 对得上（别的交易的缓存不能当现状）
    expect(code).toContain('fallbackTxId === txLoad.tx.id')
    expect(code).toContain('txBarView({')
    expect(code).toContain('failed: txFailed')
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

  test('状态条判据来自消息流最后一个交易事件（提案态与提案金额只能从消息读）', async () => {
    const code = await source()
    expect(code).toContain('lastEventOfMessages(messages)')
    expect(code).toContain('lastEvent: lastTxEvent')
    // 角色与商品状态都交给纯函数，页面上不另判一套
    expect(code).toContain('role: conversation.role')
    expect(code).toContain('listingStatus: listing.status')
    expect(code).toContain("lastTxEvent?.type === 'tx.accepted'")
  })

  test('「待评价」靠评价边判定：只有 404 REVIEW_NOT_FOUND 才算我还没评', async () => {
    const code = await source()
    expect(code).toContain('fetchMyTransactionReview(')
    expect(code).toContain('REVIEW_NOT_FOUND')
    expect(code).toContain("txLoad.tx?.status === 'COMPLETED'")
    // 判据要真的喂进状态条的入参，否则查了也白查
    const call = sliceFrom(code, 'const txBar = txBarView({', '})')
    expect(call).toContain('reviewed,')
  })

  test('五档动作都接到了：确认→二次确认 + acceptTransaction，扫码→扫码页，其余→面交页/重查', async () => {
    const code = await source()
    const bar = sliceFrom(code, 'const runTxBarAction =', "// 'wait'")
    // 动作钮不得顺带触发整条的「进商品详情」
    expect(bar).toContain('event.stopPropagation()')
    expect(bar).toContain("action.kind === 'listing'")
    expect(bar).toContain('openListing()')
    expect(bar).toContain("action.kind === 'confirm'")
    expect(bar).toContain('confirmProposal(action.amountCents)')
    expect(bar).toContain("action.kind === 'code'")
    expect(bar).toContain("action.kind === 'review'")
    expect(bar).toContain('openMeetup(action.transactionId)')
    expect(bar).toContain("action.kind === 'scan'")
    expect(bar).toContain('SCAN_CODE_PAGE')
    expect(bar).toContain("action.kind === 'retry'")
    expect(bar).toContain('retryTx()')

    // 接受提案：先二次确认，再把提案金额原样带回（提案不落库，服务端无处可读）
    const accept = sliceFrom(code, 'const confirmProposal =', 'acceptBusyRef.current = false')
    expect(accept).toContain('Taro.showModal(')
    expect(accept).toContain('acceptTransaction(conversationId, amountCents)')
    expect(code).toContain('formatAmount(amountCents)')
    // 409 不代表「接受失败」，但也不能零反馈：说一句商品现状 + 重查本页让 listing 状态跟上，
    // 否则顶部那颗「待确认」会原地复活、点一次 409 一次
    expect(accept).toContain('LISTING_NOT_ACTIVE')
    expect(accept).toContain('已被其他买家预订')
    expect(accept).toContain('loadRef.current({ silent: true })')
    expect(accept).toContain('retryTx()')
  })

  test('吸底交易卡已删除：页面不再挂 TxCard，样式里也不再有 .conv__txcard', async () => {
    const code = await source()
    expect(code).not.toContain('<TxCard')
    expect(code).not.toContain("from './tx-card'")
    expect(code).not.toContain('conv__txcard')
    // 状态只由页头一条承载：动作区在 .conv__pbar-act 里，且整条仍是「点进商品详情」
    expect(code).toContain('conv__pbar-act')
    expect(code).toContain('onClick={runTxBarAction}')
    const bar = sliceFrom(code, 'className={`conv__pbar ', 'conv__pbar-act')
    expect(bar).toContain('onClick={openListing}')
    expect(bar).toContain('conv__pbar-status')
  })

  test('从面交页写完评价返回本页：评价边按「回到本页」的信号重查（交易 id 不变也要重查）', async () => {
    const code = await source()
    // 评价是在面交页写的，返回时 completedTxId 一个字都没变 —— 只靠它做依赖会一直停在「评价」
    expect(code).toContain('setTxReviewTick((tick) => tick + 1)')
    const show = sliceFrom(code, 'useDidShow(() => {', 'setTxReviewTick((tick) => tick + 1)')
    expect(show).toContain('visibleRef.current = true')
    expect(code).toContain('}, [completedTxId, txReviewTick])')
  })

  test('接受失败不报失败口吻：409 只重查，连点被入口锁挡掉，确认框失败不炸', async () => {
    const code = await source()
    const accept = sliceFrom(code, 'const confirmProposal =', 'acceptBusyRef.current = false')
    expect(accept).toContain("error.code === 'LISTING_NOT_ACTIVE'")
    // 锁必须在弹确认框之前置真，否则两次快速点击会各起一个确认框、点两次就是两次请求
    expect(accept.indexOf('acceptBusyRef.current = true')).toBeLessThan(
      accept.indexOf('Taro.showModal('),
    )
    expect(accept).toContain('.finally(() => {')
    expect(accept).toContain('面交确认框打开失败')
    // 在途换号：迟到的 accept 响应不许写进新账号的会话
    expect(accept).toContain('const epoch = sessionEpoch()')
    expect(accept).toContain('epoch !== sessionEpoch()')
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
})
