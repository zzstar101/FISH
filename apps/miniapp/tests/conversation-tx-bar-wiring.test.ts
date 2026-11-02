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

/** 剥掉注释再断言：注释里留一份同名语句不能冒充接线（仓库既有写法，见 back-top-scroll-source.test.ts） */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 把一段请求代码切成它**实际**的回调体：`.then(...)` / `.catch(...)` 的 `{ … }`（按花括号配对，不引解析器） */
function callbackBodies(slice: string, label: string): string[] {
  const opener = /\.(then|catch)\(\(?[^()]*\)?\s*=>\s*\{/g
  const bodies: string[] = []
  for (let hit = opener.exec(slice); hit; hit = opener.exec(slice)) {
    const from = hit.index + hit[0].length
    let depth = 1
    let i = from
    while (i < slice.length && depth > 0) {
      if (slice[i] === '{') depth += 1
      else if (slice[i] === '}') depth -= 1
      i += 1
    }
    // 片段本身可能正好截在最后一个回调的 `}` 之前（例如 load 段的终点就是 .catch 里的那句），
    // 这时候取到片段末尾即可：要断言的「守卫 → return → 写状态」都在片段内，不受影响。
    bodies.push(slice.slice(from, depth === 0 ? i - 1 : slice.length))
  }
  expect(bodies.length, `${label}：应该切出实际回调`).toBeGreaterThan(0)
  /**
   * 切出的回调数量必须等于 `.then(` / `.catch(` 的出现次数。只断言「至少切出一个」
   * 时，把某个回调改写成 `function (e) {`（本正则不认）就能让**整块隐身**，连带删掉
   * 里面的守卫也全绿 —— 那正是这条用例要防的回归。
   */
  const callbacks = slice.match(/\.(then|catch)\(/g) ?? []
  expect(bodies.length, `${label}：每个 .then/.catch 都要切出回调（有回调换了写法？）`).toBe(
    callbacks.length,
  )
  return bodies
}

const TX_SEQ_GUARD = 'txSeq !== txSeqRef.current'

/**
 * latest-wins 要**每个实际回调各自**守：守卫在同一段请求里凑够条数不算数 ——
 * `.catch` 的守卫挪进 `.then`、条数不变时，迟到的失败结果仍会覆盖新到的成功结果。
 * 每个回调里的顺序固定为「守卫 → return → 写状态」，`.then` 写 `applyTx(tx)`、`.catch` 写 `setTxLoad(...)`。
 */
function expectEachCallbackGuarded(slice: string, label: string): void {
  for (const body of callbackBodies(slice, label)) {
    /**
     * 守卫必须是这个回调里的**顶层语句、且在任何状态写入之前**。只要求「回调里有这串
     * 字面量、且写在 `return` 之前」不够：把守卫塞进一个没人调用的嵌套闭包、后面照旧
     * 无条件写状态，三条 `indexOf` 断言全满足，迟到的结果照样覆盖新状态。
     * 守卫前面允许有 `console.warn(...)` 这类无副作用的取证日志，但不许有花括号
     * （= 已经进入嵌套块）也不许有状态写入。
     */
    const guard = body.indexOf(TX_SEQ_GUARD)
    const beforeGuard = body.slice(0, guard === -1 ? body.length : guard)
    expect(beforeGuard, `${label}：守卫不能藏在嵌套块里`).not.toMatch(/[{}]/)
    expect(beforeGuard, `${label}：守卫之前不许先写状态`).not.toMatch(/applyTx\(|setTxLoad\(/)
    expect(guard, `${label}：每个回调里都要有 latest-wins 守卫`).toBeGreaterThanOrEqual(0)
    const bail = body.indexOf('return', guard)
    expect(bail, `${label}：守卫后面要 return 掉迟到的结果`).toBeGreaterThan(guard)
    const write = body.search(/applyTx\(tx\)|setTxLoad\(/)
    expect(write, `${label}：回调里应有状态写入`).toBeGreaterThanOrEqual(0)
    expect(write, `${label}：守卫必须在这个回调写状态之前`).toBeGreaterThan(bail)
  }
}

describe('#551 会话页页头交易状态条 · 接线', () => {
  test('每次 load 都按会话查交易，并把首屏 tx.accepted 的 id 作为精确查询的首选', async () => {
    // 剥注释：`not.toContain` 用原始源码时，注释里抄一遍旧地址就会假红
    const code = stripComments(await source())
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

  test('交易请求 latest-wins：三条请求路径各自取号，每个回调各自守卫', async () => {
    const code = stripComments(await source())
    expect(code).toContain('const txSeqRef = useRef(0)')
    const takes = (slice: string) => slice.match(/const txSeq = \+\+txSeqRef\.current/g) ?? []

    // 进页 / 返回 / 补刷：取号一次，.then 与 .catch 各守一次
    const load = sliceFrom(
      code,
      'const txSeq = ++txSeqRef.current',
      "setTxLoad((prev) => ({ status: 'failed', tx: prev.tx }))",
    )
    expect(load).toContain('lastTxAcceptedId(page.items)')
    expect(takes(load)).toHaveLength(1)
    expectEachCallbackGuarded(load, 'load')

    // 20s 轮询两条路径（失败重试列表 / PENDING 按 id 查详情）：各自取号，四个回调各自守
    const poll = sliceFrom(code, 'timer = setInterval(', 'presenceSeq.current += 1')
    expect(takes(poll)).toHaveLength(2)
    expectEachCallbackGuarded(poll, 'poll')

    // 失败卡「重新加载」：同样取号一次、两个回调各自守
    const retry = sliceFrom(
      code,
      'const retryTx = useCallback(',
      '}, [applyTx, conversation, conversationId, fallbackTxId])',
    )
    expect(takes(retry)).toHaveLength(1)
    expectEachCallbackGuarded(retry, 'retry')
  })

  test('状态条判据来自消息流最后一个交易事件（提案态与提案金额只能从消息读）', async () => {
    // 必须剥注释：整文件存在性断言会让「注释里留一份旧表达式」把行为破坏顶掉
    const code = stripComments(await source())
    expect(code).toContain('const lastTxEvent = lastEventOfMessages(messages)')
    // 判据还得真的接到状态条上：只算出来不传进 txBarView，提案态与金额照样读不到
    const call = sliceFrom(code, 'const txBar = txBarView({', '})')
    expect(call).toContain('lastEvent: lastTxEvent')
    // 角色与商品状态都交给纯函数，页面上不另判一套
    expect(code).toContain('role: conversation.role')
    expect(code).toContain('listingStatus: listing.status')
    expect(code).toContain("lastTxEvent?.type === 'tx.accepted'")
  })

  test('首屏交易查询还在 idle 时不给「查看交易码」兜底：这道闸不许被简化掉', async () => {
    // 剥注释：注释里留一份同名三元表达式不能冒充接线
    const code = stripComments(await source())
    const call = sliceFrom(code, 'const txBar = txBarView({', '})')
    /**
     * `idle` = 首屏交易查询还没回来，不是「查不到」。此时把消息里的 `tx.accepted` id 当兜底
     * 入口摆出来，会先闪一下「查看交易码」再变回商品状态 —— 这条闸存在的唯一理由就是防这一闪，
     * 所以必须钉住整条三元表达式：只断言 `fallbackTxId,` 在场，改回裸传也照样绿。
     */
    expect(call).toContain("fallbackTxId: txLoad.status === 'idle' ? null : fallbackTxId")
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

  test('评价查询失败不落成「未评价」：只有 404 写 false，其余失败留在未知态', async () => {
    const code = stripComments(await source())
    const effect = sliceFrom(
      code,
      'void fetchMyTransactionReview(completedTxId)',
      '}, [completedTxId, txReviewTick])',
    )
    // 「我还没评」只有一个来源：404 REVIEW_NOT_FOUND
    const notFound = effect.indexOf("error.code === 'REVIEW_NOT_FOUND'")
    expect(notFound).toBeGreaterThanOrEqual(0)
    const falses = effect.match(/reviewed: false/g) ?? []
    expect(falses).toHaveLength(1)
    expect(effect.indexOf('reviewed: false')).toBeGreaterThan(notFound)
    // 其余失败（网络 / 500）不写 false，也不保留上一轮的结论：回到未知态
    const failureTail = effect.slice(effect.indexOf('console.warn('))
    expect(failureTail).not.toContain('reviewed: false')
    expect(failureTail).toContain('setTxReview(null)')
  })

  test('五档动作都接到了：确认→二次确认 + acceptTransaction，扫码→扫码页，其余→面交页/重查', async () => {
    // 剥注释：切片终点与断言都不许把注释当承重墙（下面用真实语法边界 `return (`）
    const code = stripComments(await source())
    const bar = sliceFrom(code, 'const runTxBarAction =', '\n  return (')
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
    // 卖家提案态的「拒绝」也走同一个分发入口（次要钮显式传动作进来）
    expect(bar).toContain("action.kind === 'reject'")
    expect(bar).toContain('declineProposal()')
    expect(bar).toContain('action: TxBarAction = txBar.action')

    // 接受提案：先二次确认，再把提案金额原样带回（提案不落库，服务端无处可读）
    const accept = sliceFrom(code, 'const confirmProposal =', 'acceptBusyRef.current = false')
    expect(accept).toContain('Taro.showModal(')
    /**
     * 入口锁的另一半：**进来先读锁**。只钉「在 showModal 之前置真」是不够的 —— 把
     * `if (acceptBusyRef.current) return` 删掉后，置真照样发生在 showModal 之前，锁却再也
     * 没人读，两次快速点击就会各起一个确认框、两次「确认」就是两次 accept 请求。
     * 所以这一段必须在**本函数里**、且在 `Taro.showModal(` 之前（`code` 已剥注释，
     * 注释里留一份同名语句不能冒充）。
     */
    expect(accept).toContain('if (acceptBusyRef.current) return')
    expect(accept.indexOf('if (acceptBusyRef.current) return')).toBeLessThan(
      accept.indexOf('Taro.showModal('),
    )
    expect(accept).toContain('acceptTransaction(conversationId, amountCents)')
    expect(code).toContain('formatAmount(amountCents)')
    // 409 不代表「接受失败」，但也不能零反馈：说一句商品现状 + 重查本页让 listing 状态跟上，
    // 否则顶部那颗「待确认」会原地复活、点一次 409 一次
    expect(accept).toContain('LISTING_NOT_ACTIVE')
    /**
     * 文案不许断言成因：`LISTING_NOT_ACTIVE` 只说明「商品已不在售」，可能是下架、已被
     * 别人订走 / 卖掉，也可能是上一次其实成功了、这次是响应丢失后的重试。写死「已被其他
     * 买家预订」在另两种情况下就是假消息。断言针对**用户看到的串**，所以先剥注释。
     */
    const acceptCopy = stripComments(accept)
    expect(acceptCopy).toContain('已不在售')
    expect(acceptCopy).not.toContain('其他买家预订')
    expect(acceptCopy).not.toContain('别的买家')
    // 失败后的重拉与重查口径见下面「静默重拉」与「迟到的旧快照」两条用例
  })

  test('卖家提案态的「拒绝」：二次确认 + 只写 tx.rejected 消息，重拉本页让顶部自己退回在售', async () => {
    const code = await source()
    expect(code).toContain('rejectProposal,')
    const decline = sliceFrom(code, 'const declineProposal =', 'acceptBusyRef.current = false')
    expect(decline).toContain('Taro.showModal(')
    expect(decline).toContain('rejectProposal(conversationId)')
    // 拒绝不建交易行、不改商品状态：本地不假改，重拉本页让那条 tx.rejected 消息说话
    expect(decline).toContain('已拒绝 · 商品仍在售')
    // 重拉必须走「有在途发送就只记账」的统一出口（见下一条用例），不许裸调 load
    expect(decline).toContain('refreshConversationQuietly(')
    expect(decline).not.toContain('loadRef.current({ silent: true })')
    // 与接受共用一把锁，且必须在弹确认框之前置真
    expect(decline.indexOf('acceptBusyRef.current = true')).toBeLessThan(
      decline.indexOf('Taro.showModal('),
    )
    /**
     * 入口锁的另一半：**进来先读锁**（与接受同一条纪律）。只钉置真的位置不够 —— 删掉
     * `if (acceptBusyRef.current) return` 后置真仍在 showModal 之前，锁却没人读，两次快速点
     * 点出两个确认框。本用例切的是未剥注释的源码，所以断言前单独剥一次，避免注释里那句
     * 「入口就上锁」被当成承重墙。
     */
    const declineCode = stripComments(decline)
    expect(declineCode).toContain('if (acceptBusyRef.current) return')
    expect(declineCode.indexOf('if (acceptBusyRef.current) return')).toBeLessThan(
      declineCode.indexOf('Taro.showModal('),
    )
    expect(decline).toContain('.finally(() => {')
    // 在途换号：迟到的 reject 响应不许把上一个账号的页面刷成「已拒绝」
    expect(decline).toContain('const epoch = sessionEpoch()')
    expect(decline).toContain('epoch !== sessionEpoch()')
    // 拒绝之后没有交易可推（#511 审查的口径）：这里不该请求 TX 订阅授权
    expect(decline).not.toContain('requestSubscribe')
    // 次要钮必须真的渲出来，并且带自己的动作（不能复用主钮的 confirm）
    expect(code).toContain('secondaryTxBar')
    expect(code).toContain('conv__pbar-act--ghost')
    expect(code).toContain('runTxBarAction(event, secondaryTxBar.action)')
  })

  test('接受 / 拒绝后的静默重拉走统一出口：有在途发送只记账，不把乐观气泡判死（#551 审查 F1）', async () => {
    const code = stripComments(await source())
    /**
     * `load()` 一进来就 `++epoch.current`，在途的文本发送 / 媒体上传回来时会被
     * `current !== epoch.current` 判过期丢弃 —— 气泡永远「发送中」，而消息可能已落库。
     * 所以接受 / 拒绝之后的重拉必须与 `useDidShow` / `realtimeOpenRef` 同一条纪律。
     */
    const quiet = sliceFrom(
      code,
      'const refreshConversationQuietly =',
      'loadRef.current({ silent: true })',
    )
    expect(quiet).toContain("item.status === 'sending'")
    expect(quiet).toContain("item.status === 'uploading'")
    expect(quiet).toContain('deferredRef.current = deferReload(deferredRef.current)')
    // 记账必须在重拉之前，且记账那一支要 return 掉（不能记完照样拉）
    const deferred = quiet.indexOf('deferredRef.current = deferReload(deferredRef.current)')
    const reload = quiet.indexOf('loadRef.current({ silent: true })')
    expect(deferred).toBeGreaterThanOrEqual(0)
    expect(reload).toBeGreaterThan(deferred)
    expect(quiet.slice(deferred, reload)).toContain('return')

    // 三个调用点（接受 409 / 拒绝成功 / 拒绝失败）全部改用它，页面里不再有裸 load
    const accept = sliceFrom(code, 'const confirmProposal =', 'const declineProposal =')
    const decline = sliceFrom(code, 'const declineProposal =', 'const tail = entries.length > 0')
    expect(accept).toContain('refreshConversationQuietly()')
    expect(accept).not.toContain('loadRef.current({ silent: true })')
    expect(decline.match(/refreshConversationQuietly\(\)/g) ?? []).toHaveLength(2)
    expect(decline).not.toContain('loadRef.current({ silent: true })')
  })

  test('接受 409 不重复查交易：load 内部已经重查，不再顺手 retryTx 一次（#551 审查 F1 附带）', async () => {
    const code = stripComments(await source())
    const accept = sliceFrom(code, 'const confirmProposal =', 'const declineProposal =')
    // 只剩通用失败分支那一处 retryTx（409 分支由 refreshConversationQuietly 覆盖）
    expect(accept.match(/retryTx\(\)/g) ?? []).toHaveLength(1)
    expect(accept.indexOf('retryTx()')).toBeGreaterThan(accept.indexOf('接受没成功，请重试'))
  })

  test('接受成功后先作废在途交易查询，迟到的旧快照不许把交易码入口顶回提案档（#551 审查 F2）', async () => {
    const code = stripComments(await source())
    const accept = sliceFrom(code, 'const confirmProposal =', 'const declineProposal =')
    const onAccepted = sliceFrom(
      accept,
      'return acceptTransaction(conversationId, amountCents)',
      "void Taro.showToast({ title: '已接受，去面交吧'",
    )
    // 进页那次交易查询可能还在飞（无 preferredTxId 时是多次串行请求）：不把它判过期，
    // accept 先回来、旧快照后到就可能 `applyTx(null)`，顶部掉回提案档且 listing 已被置 RESERVED
    expect(onAccepted).toContain('++txSeqRef.current')
    expect(onAccepted.indexOf('++txSeqRef.current')).toBeLessThan(onAccepted.indexOf('applyTx(tx)'))
    // 不许顺手加别的守卫：身份闸仍然只有 sessionEpoch
    expect(onAccepted).not.toContain('epoch.current')
  })

  test('接受提案在手势同步阶段请求 TX 订阅授权；拒绝不请求（#462 / #551 审查 F4）', async () => {
    const code = stripComments(await source())
    const accept = sliceFrom(code, 'const confirmProposal =', 'const declineProposal =')
    // #462 冻结口径：同意提案时请求 TX 授权（同仓 mylist 的 acceptProposal 同一处）
    expect(accept).toContain("requestSubscribe(['TX'])")
    // 微信硬约束：必须仍在用户手势的同步阶段 —— 不能等到弹框 / await 之后
    const ask = accept.indexOf("requestSubscribe(['TX'])")
    expect(ask).toBeGreaterThanOrEqual(0)
    expect(ask).toBeLessThan(accept.indexOf('Taro.showModal('))
    expect(ask).toBeLessThan(accept.indexOf('acceptBusyRef.current = true'))
    // 拒绝之后没有交易可推，保持不请求（Issue 只对拒绝明示豁免）
    const decline = sliceFrom(code, 'const declineProposal =', 'const tail = entries.length > 0')
    expect(decline).not.toContain('requestSubscribe')
  })

  test('买家「待卖家确认」没有可点的动作：动作区整块不渲染，不会长出空药丸（#551 审查 F6）', async () => {
    const code = stripComments(await source())
    // 这一档 `txBar.action.kind === 'wait'`，右栏整块不渲染（否则会渲染一颗没有文案的按钮）
    expect(code).toContain("txBar.action.kind === 'wait' ? null")
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
    const code = stripComments(await source())
    // 只看 SYSTEM 胶囊那一段：在全文里搜字符串，会被别处的同名代码或注释顶替
    const capsule = sliceFrom(
      code,
      'const renderSystem = (message: MessageDto) => {',
      'const renderListing = (',
    )
    // 判据本身要带 tx.accepted 谓词：同一片段里的 noIdHint 也有这串字面量，全文/整段搜会被它顶替
    const criterion = sliceFrom(
      capsule,
      'const historical =',
      'const historicalTxId = historical ? txId : null',
    )
    expect(criterion).toContain("event?.type === 'tx.accepted'")
    // 判据：与当前交易行不同就算历史；查不到当前交易行（接口失败 / 数据缺失）时也要保留入口
    expect(capsule).toContain('txLoad.tx === null || txId !== txLoad.tx.id')
    expect(capsule).toContain('已接受交易 · 查看本笔')
    // 交给 openMeetup 的必须是这条消息自己的 id（不能换成当前交易 / 最后一条 accepted 的 id）
    expect(capsule).toContain('const historicalTxId = historical ? txId : null')
    // 光有文案不够：onClick 必须真的就是这个三元表达式，否则胶囊点了没反应
    expect(capsule).toContain(
      'historicalTxId ? () => openMeetup(historicalTxId) : noIdHint ? goOrders : undefined',
    )
  })

  test('老数据的 tx.accepted 没带 id 时不让用户白点，明确指到「我的订单」', async () => {
    const code = await source()
    expect(code).toContain('已接受交易 · 请从「我的订单」查看')
    // 这句话本身要能点进订单页，否则只是换个说法让用户自己找
    expect(code).toContain('noIdHint ? goOrders : undefined')
    expect(code).toContain("conversation.role === 'buyer'")
  })
})
