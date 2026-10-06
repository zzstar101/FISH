import { describe, expect, mock, test } from 'bun:test'

/**
 * 订单列表的身份结转规则（#89 审查收口）。
 *
 * `useOrderList` 的 state 是账号作用域的：换账号 / 退出登录回到压在栈里的订单页时，
 * 旧账号的列表、错误态、截断标记都必须整片作废。判定抽成纯函数锁住组合；
 * 组件接线（渲染期调用、请求代次自增）同仓库先例靠 code review 保证。
 *
 * 为什么 `mock.module`：`useOrderList.ts` 经 `loadOrders → features/fetchers → lib/request`
 * 静态拖着 `@tarojs/taro`，而 Bun 下加载真 Taro 会抛 `ENABLE_INNER_HTML is not defined`。
 * 手法与 `wishes-api.test.ts` 一致：`mock.module` 后再动态 import 被测模块
 * （静态 import 会被提升到 mock 之前，顶替就不生效了）。
 */
mock.module('@tarojs/taro', () => ({ default: {} }))

// 构建期注入的开关（`config/index.ts` 的 defineConstants）。被测模块经
// `features/fetchers` 静态拖着 `features/auth/demo.ts`，它在模块求值阶段就读
// `__DEMO_AUTH__`；不定义会在 import 时 ReferenceError（同 `wishes-api.test.ts`）。
Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: true })

const { nextIdentityState } = await import('../src/features/transaction/useOrderList')

/* ------------------------------------------------------------------ *
 * 卡上三条写路径（取消交易 / 读评价边 / 提交评价）—— 源码层接线断言
 *
 * 订单卡组件没有渲染基建（仓库里所有 tests/*.test.ts 都不挂 Taro 渲染），
 * 所以这里沿 `product-card-menu.test.ts` 的手法：读 `index.tsx` **去掉注释后**的
 * 源码，按顺序切开三条写路径。为什么值得钉：这三条路径本身编译得过、端上点一次
 * 也看不出来，坏起来全是静默的 ——
 *   · 取消成功不 `onRefresh`（列表停在「待面交」，用户以为没生效）；
 *   · 取消失败也刷新（把「取消成功」的错觉画进列表）；
 *   · 读评价边把 404 `REVIEW_NOT_FOUND` 当成错误弹 toast（本就没评价过，
 *     这是**正常**分支，弹了用户就再也进不去评价卡）；
 *   · 没选档位静默返回（按钮只是降了透明度，点下去什么都不发生）；
 *   · 空评语也给 `body: ''`（契约里「只打分」是省略字段，空串会被 422 拒）。
 * ------------------------------------------------------------------ */

/** 源码读成字符串；路径与 `index.tsx` 同侧的组件目录 */
async function orderListSource(): Promise<string> {
  return await Bun.file(new URL('../src/components/order-list/index.tsx', import.meta.url)).text()
}

/** 去掉注释后的源码：断言必须看**代码**（源码里正逐条解释这些机制，含注释即可蒙混过关） */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 压掉空白：biome 会把单行 `if` / 多行对象折成别的形状，按原样匹配就把格式当成了语义 */
function flat(source: string): string {
  return source.replace(/\s+/g, ' ')
}

/** 取 `from` 到其后第一个 `to` 之间的**代码**（两端都不含），并压平空白 */
async function sliceFlat(from: string, to: string): Promise<string> {
  const text = flat(codeOnly(await orderListSource()))
  const start = text.indexOf(flat(from))
  expect(start, `订单卡源码里缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(flat(to), start + from.length)
  expect(end, `订单卡源码里缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + flat(from).length, end)
}

/** 断言 `later` 出现在 `earlier` **之后**（只钉「子串存在」的话，把落地语句提到守卫前仍会全绿） */
function expectAfter(body: string, earlier: string, later: string, why: string): void {
  const at = body.indexOf(earlier)
  expect(at, `${why}：找不到 ${earlier}`).toBeGreaterThanOrEqual(0)
  expect(
    body.indexOf(later, at + earlier.length),
    `${why}：${later} 没有落在 ${earlier} 之后`,
  ).toBeGreaterThan(at)
}

const CANCEL = 'const cancelOrder = (item: OrderCardView) => {'
const OPEN_REVIEW = 'const openReview = (item: OrderCardView) => {'
const SUBMIT_REVIEW = 'const submitReview = () => {'
const BACK_TO_TOP = 'const backToTop = () => {'

describe('nextIdentityState —— 订单列表身份结转规则', () => {
  test('冷启动首帧（还没有身份、手里也没有数据）：idle —— 不加载，也没有东西要清', () => {
    expect(nextIdentityState(null, null)).toBe('idle')
  })

  test('退出登录（手里还挂着上一个账号的数据）：reset —— 不能残留旧账号订单', () => {
    expect(nextIdentityState('u-1', null)).toBe('reset')
  })

  test('首次拿到身份：reset —— 把初始「空 + loading」当作待加载', () => {
    expect(nextIdentityState(null, 'u-1')).toBe('reset')
  })

  test('身份未变：keep —— 已属于当前账号的列表原样保留', () => {
    expect(nextIdentityState('u-1', 'u-1')).toBe('keep')
  })

  test('换账号：reset —— 旧账号订单不能挂在新账号视角下', () => {
    expect(nextIdentityState('u-1', 'u-2')).toBe('reset')
  })
})

describe('cancelOrder —— 取消交易（订单卡写路径）', () => {
  test('二级确认：先 showModal 拿 confirm，用户取消就整条返回、不发请求', async () => {
    const body = await sliceFlat(CANCEL, OPEN_REVIEW)
    expect(body).toContain('Taro.showModal(')
    expectAfter(body, 'Taro.showModal(', 'if (!result.confirm) return', '取消交易必须先过确认')
    expectAfter(
      body,
      'if (!result.confirm) return',
      'cancelTransaction(item.id)',
      '确认之后才发请求',
    )
  })

  test('在飞挡连点：进入时先看 cancelBusyId，且 finally 一定要清掉', async () => {
    const body = await sliceFlat(CANCEL, OPEN_REVIEW)
    expect(body).toContain('if (cancelBusyId !== null) return')
    expectAfter(
      body,
      'setCancelBusyId(item.id)',
      'await cancelTransaction(item.id)',
      '先画「取消中」再发请求',
    )
    expectAfter(
      body,
      'await cancelTransaction(item.id)',
      'setCancelBusyId(null)',
      '请求收尾必须解锁',
    )
  })

  test('成功才刷新：await cancelTransaction 之后才 onRefresh，失败分支里没有 onRefresh', async () => {
    const body = await sliceFlat(CANCEL, OPEN_REVIEW)
    expectAfter(body, 'await cancelTransaction(item.id)', 'onRefresh?.()', '取消成功才重拉列表')
    // 失败分支 = catch 到 finally 之间：只提示，不刷新、不本地翻转状态（服务端返回才是权威）
    const catchAt = body.indexOf('} catch (caught) {')
    expect(catchAt, '取消交易必须有 catch 分支').toBeGreaterThanOrEqual(0)
    const finallyAt = body.indexOf('} finally {', catchAt)
    expect(finallyAt, '取消交易必须有 finally 分支').toBeGreaterThan(catchAt)
    const failure = body.slice(catchAt, finallyAt)
    expect(failure).toContain('Taro.showToast(')
    expect(failure).toContain("isApiError(caught) ? caught.message : '取消没成功，请重试'")
    expect(failure).not.toContain('onRefresh')
  })

  test('不本地翻转：整条路径里没有任何 setStatus / setSortDesc / 列表状态改写', async () => {
    const body = await sliceFlat(CANCEL, OPEN_REVIEW)
    expect(body).not.toContain('setStatus(')
    expect(body).not.toContain('setSortDesc(')
    // showModal 自己 reject 时不能变成未处理拒绝（端上会静默吞掉）
    expect(body).toContain('.catch(() => {})')
  })
})

describe('openReview —— 读评价边（订单卡写路径）', () => {
  test('先读边：进函数先挡连点，再 setReviewCheckingId，finally 一定解锁', async () => {
    const body = await sliceFlat(OPEN_REVIEW, SUBMIT_REVIEW)
    expect(body).toContain('if (reviewCheckingId !== null || reviewBusy) return')
    expectAfter(
      body,
      'setReviewCheckingId(item.id)',
      'fetchMyTransactionReview(item.id)',
      '先画「查询中」再发请求',
    )
    expectAfter(
      body,
      'fetchMyTransactionReview(item.id)',
      'setReviewCheckingId(null)',
      '查询收尾必须解锁',
    )
  })

  test('404 REVIEW_NOT_FOUND 是正常分支：清档位与评语、开弹层、直接 return（不弹错误 toast）', async () => {
    const body = await sliceFlat(OPEN_REVIEW, SUBMIT_REVIEW)
    expect(body).toContain("isApiError(caught) && caught.code === 'REVIEW_NOT_FOUND'")
    const branchAt = body.indexOf("caught.code === 'REVIEW_NOT_FOUND'")
    const branchEnd = body.indexOf('return', branchAt)
    expect(branchEnd, 'REVIEW_NOT_FOUND 分支必须 return，不能继续往下弹错误 toast').toBeGreaterThan(
      branchAt,
    )
    const branch = body.slice(branchAt, branchEnd)
    expectAfter(
      branch,
      'setReviewTier(null)',
      "setReviewBody('')",
      '开弹层前先清掉上一次的档位与评语',
    )
    expectAfter(branch, "setReviewBody('')", 'setReviewTarget(item)', '清完再开弹层')
    // 弹层目标只能是**这一笔**交易（写错成 items[0] 之类就是把评价挂到别的订单上）
    expect(branch).toContain('setReviewTarget(item)')
  })

  test('已评过（200）不弹层：只把这张卡转「已评价」并说明', async () => {
    const body = await sliceFlat(OPEN_REVIEW, SUBMIT_REVIEW)
    expectAfter(
      body,
      'fetchMyTransactionReview(item.id)',
      'setReviewedIds(',
      '读边成功要标记这张卡',
    )
    expectAfter(body, 'setReviewedIds(', "title: '这笔交易已经评价过了'", '标记之后说明原因')
    expectAfter(
      body,
      'fetchMyTransactionReview(item.id)',
      'Taro.showToast(',
      '读边失败要给一句提示',
    )
    expect(body).toContain("caught.message : '没读到评价状态，请重试'")
    const thenAt = body.indexOf('.then(() => {')
    const catchAt = body.indexOf('.catch((caught: unknown) => {', thenAt)
    expect(catchAt).toBeGreaterThan(thenAt)
    expect(body.slice(thenAt, catchAt)).not.toContain('setReviewTarget')
  })
})

describe('submitReview —— 提交评价（订单卡写路径）', () => {
  test('没选档位不静默：先 toast 再 return，且这一步不发请求', async () => {
    const body = await sliceFlat(SUBMIT_REVIEW, BACK_TO_TOP)
    expect(body).toContain('if (reviewTarget === null || reviewBusy) return')
    const tierAt = body.indexOf('if (reviewTier === null) {')
    expect(tierAt, '没选档位必须显式判断').toBeGreaterThanOrEqual(0)
    const guard = body.slice(tierAt, body.indexOf('setReviewBusy(true)', tierAt))
    expect(guard).toContain("title: '请先选好评 / 中评 / 差评'")
    expect(guard).toContain('return')
    expect(guard).not.toContain('createTransactionReview')
  })

  test('载荷：rating 取档位，评语 trim 后为空就省略 body 字段（契约的正常形态）', async () => {
    const body = await sliceFlat(SUBMIT_REVIEW, BACK_TO_TOP)
    expect(body).toContain('const trimmed = reviewBody.trim()')
    expectAfter(
      body,
      'const trimmed = reviewBody.trim()',
      'createTransactionReview(',
      '先 trim 再组载荷',
    )
    expect(body).toContain('rating: reviewTier')
    expect(body).toContain("...(trimmed === '' ? {} : { body: trimmed })")
    expect(body).not.toContain("body: ''")
  })

  test('提交成功才关弹层：toast + 标记已评价 + setReviewTarget(null)，finally 解锁', async () => {
    const body = await sliceFlat(SUBMIT_REVIEW, BACK_TO_TOP)
    const thenAt = body.indexOf('.then(() => {')
    const catchAt = body.indexOf('.catch((caught: unknown) => {', thenAt)
    expect(catchAt, '提交评价必须有 catch 分支').toBeGreaterThan(thenAt)
    const success = body.slice(thenAt, catchAt)
    expectAfter(success, 'setReviewedIds(', 'setReviewTarget(null)', '标记完再关弹层')
    expect(success).toContain("title: '评价已提交'")
    expectAfter(body, 'setReviewTarget(null)', 'setReviewBusy(false)', '请求收尾必须解锁')
    // 失败不关弹层：用户写的评语不能因为一次网络抖动就丢
    const catchAt2 = body.indexOf('.catch((caught: unknown) => {', thenAt)
    const finallyAt = body.indexOf('.finally(', catchAt2)
    const failure = body.slice(catchAt2, finallyAt)
    expect(failure).toContain('Taro.showToast(')
    expect(failure).not.toContain('setReviewTarget(null)')
  })
})

/* ------------------------------------------------------------------ *
 * 同批（#459）的另一处：详情页「谁在求购」那段过期注释。
 *
 * 原文写「`items` 只是这一页（服务端默认 10 条）」—— 这是**错的原因**：本页
 * `fetchListingMatches(matchListingId)` 从不传 limit，吃的是 features/match/api.ts
 * 的默认参数 `limit: number = MATCH_LIMIT_MAX`，而 `MATCH_LIMIT_MAX = 50`（同文件
 * :17）。所以差额来自「本页只取前 50 位」，不是「服务端只给 10 条」。
 *
 * 注释也会被当成事实读（这段正拿它解释下面那句「共 N 位，显示前 M 位」），所以把
 * 「错误的原因」钉住：改回去就红。断言跑在**带注释的原文**上 —— 这里要的正是注释文字。
 * ------------------------------------------------------------------ */

describe('listing-detail —— 「谁在求购」差额说明的原因必须与代码一致', () => {
  test('不再写「服务端默认 10 条」，改成本页按 MATCH_LIMIT_MAX 满额取', async () => {
    const source = await Bun.file(
      new URL('../src/pkg-browse/pages/listing-detail/index.tsx', import.meta.url),
    ).text()
    // 过期原因：服务端默认 10 条 —— 与真实调用不符（本页不传 limit）
    expect(source).not.toContain('服务端默认 10 条')
    // 正确原因：本页自己按 MATCH_LIMIT_MAX 满额取
    expect(source).toContain('MATCH_LIMIT_MAX = 50')
    expect(source).toContain('features/match/api.ts')
    // 与真正的默认值对上（默认参数若被改动，这段注释与差额说明同时失真）
    const matchApi = await Bun.file(new URL('../src/features/match/api.ts', import.meta.url)).text()
    expect(matchApi).toContain('const MATCH_LIMIT_MAX = 50')
    expect(matchApi).toContain('limit: number = MATCH_LIMIT_MAX')
  })
})
