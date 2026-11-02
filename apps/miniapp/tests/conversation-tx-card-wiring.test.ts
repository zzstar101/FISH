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

describe('#521 / #522 会话页交易进度卡 · 接线', () => {
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

  test('取消后新提案的判据来自消息流（详情里的 lastMessage 会滞后）', async () => {
    // 必须剥注释：整文件存在性断言会让「注释里留一份旧表达式」把行为破坏顶掉
    const code = stripComments(await source())
    expect(code).toContain('lastEventOfMessages(messages)?.type')
    // 判据还得真的接到卡片上：只算出来不传进 txCardView，卡片照样不会收起
    const card = sliceFrom(code, 'const txCard =', 'const statusLabel')
    expect(card).toContain('lastEventType: lastTxEventType')
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

  test('卡片按 CTA 语义分流：retry 就地重查，open 走带 id 的面交页', async () => {
    const code = await source()
    expect(code).toContain('<TxCard')
    expect(code).toContain(
      "txCard.action === 'retry' ? retryTx() : openMeetup(txCard.transactionId)",
    )
  })
})
