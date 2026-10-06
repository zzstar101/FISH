import { describe, expect, mock, test } from 'bun:test'
import {
  conversationUrlOf,
  DEMO_ORDER_HINT,
  meetupUrlOf,
} from '../src/features/transaction/order-links'

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

/**
 * 演示兜底那条分支（#304）要走到 `demoOrderViews`，而真实取数会真发请求 —— 把交易 API
 * 换成可控的失败源，「真实失败 → 退回 fixture」才可复现；失败分类判据仍走真实模块。
 * 必须在动态 import 之前注册，否则 `fetchers` 已经绑定了真模块（同 mock.module 的纪律）。
 */
let ordersFailure: unknown = new Error('用例没有设置失败')
mock.module('@/features/transaction/api', () => ({
  fetchAllTransactions: () => Promise.reject(ordersFailure),
}))

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

/**
 * 注入表达式是不是「只由 `mockEnabled` 决定」。
 *
 * 允许括号与**偶数个** `!`（`!(!mockEnabled)` / `!!mockEnabled` 与 `mockEnabled` 语义等价，
 * 换个写法不该红）；出现别的标识符 / `||` / `true` 之类字面量就算掺了第二个开关；
 * **奇数个** `!` 是语义反转（生产反而打开演示兜底），同样要红。
 */
function onlyMockEnabled(expr: string): boolean {
  if (!/^[!()\s]*mockEnabled[!()\s]*$/.test(expr.trim())) return false
  return (expr.match(/!/g) ?? []).length % 2 === 0
}

/** 取 `KEY: <表达式>` 的表达式文本（去掉尾逗号与首尾空白）。 */
function injectedExpr(code: string, key: string): string {
  const match = code.match(new RegExp(`${key}: ([^\\n]+)`))
  expect(match, `config 里应有 ${key} 注入点`).not.toBeNull()
  return (match?.[1] ?? '').replace(/,\s*$/, '').trim()
}

/** 取出 `KEY: JSON.stringify(<表达式>)` 里的内部表达式。 */
function stringifiedInjection(code: string, key: string): string {
  const expr = injectedExpr(code, key)
  const match = expr.match(/^JSON\.stringify\(([\s\S]*)\)$/)
  expect(match, `${key} 应写成 JSON.stringify(<表达式>)：${expr}`).not.toBeNull()
  return (match?.[1] ?? expr).trim()
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

/* ------------------------------------------------------------------ *
 * 同批（#304 / #182）：演示订单不许冒充真实订单。
 *
 * 症状（修复前）：开发构建（`NODE_ENV=development`，即 `bun run dev:weapp`）里后端一挂，
 * 订单页整片换成 fixture（id 是 `t-101` 这种假 id），用户点「打开二维码」就进
 * 真实面交页 → 404「找不到这笔交易」；点「查看会话」也一样。
 *
 * 三处钉子：
 *   1. 兜底开关只认显式 `TARO_APP_MOCK=1`（development 不再自动打开）；
 *   2. 投影层把来源写成一等字段（`source: 'real' | 'demo'`），卡片据此打角标；
 *   3. 演示来源的四条路径（面交页 / 会话页 / 取消 / 评价）在点击时统一拦下。
 *
 * 第 3 条里两条**跳转**不再靠读源码：地址由 `features/transaction/order-links` 按来源算出，
 * 演示来源**没有地址**（`null`），所以下面断言的是真实 URL —— 改错地址、或让演示来源重新
 * 拿到地址都会红。两条**写接口**没有地址可拦，仍按本文件的手法做源码切片
 * （守卫必须落在发请求之前）；组件没有渲染基建，第 2 条走真实链路。
 * ------------------------------------------------------------------ */

const BLOCK_IF_DEMO = 'const blockIfDemo = (item: OrderCardView): boolean => {'
const OPEN_CONVERSATION = 'const openConversation = (item: OrderCardView) => {'

describe('演示兜底开关 —— 只认显式 TARO_APP_MOCK=1（#304）', () => {
  test('兜底判定只有一处定义，且四个注入点都取自它（development 不再自动打开）', async () => {
    const code = codeOnly(await Bun.file(new URL('../config/index.ts', import.meta.url)).text())
    // 精确到行尾：`=== '1' || process.env.NODE_ENV === 'development'` 这种追加改法也要红
    expect(code).toMatch(/const mockEnabled = process\.env\.TARO_APP_MOCK === '1'\n/)
    // 四个注入点（alias + 三个 defineConstants）共用这一个表达式，不许各自重抄一遍
    expect(code.match(/process\.env\.TARO_APP_MOCK === '1'/g)?.length).toBe(1)
    // 但「只此一处」是间接兜：它管不到注入值被换掉。实测（2026-10-06）把
    // `__ALLOW_MOCK_FALLBACK__` 改成 `JSON.stringify(mockEnabled || process.env.NODE_ENV
    // === 'development')` 或直接 `JSON.stringify(true)`，上面两条**全绿**。
    // 注意这两种突变**不是**「静默回退 fixture」：alias 仍把 `@/features/mock-fallback`
    // 指向生产桩，桩里当场 throw `mock fallback is disabled in production builds` —— 兜底分支
    // 一被走到就报错，而不是悄悄换成 `t-*` 演示订单（那要 alias 也失守，由
    // `tests/mock-boundary.test.ts` 的 alias 键序用例守着）。所以四个注入点逐点钉死：
    // 注入值只能由 `mockEnabled` 决定。
    // 按**表达式**钉而不是按文本钉：`!(!mockEnabled)` 这类语义等价改写不该误报
    // （#478 复审 CUST-g 实测「计数 = 3」会误报）。
    for (const key of ['__ALLOW_MOCK_FALLBACK__', '__DEMO_AUTH__', '__DEMO_AI_POLISH__']) {
      const inner = stringifiedInjection(code, key)
      expect(onlyMockEnabled(inner), `${key} 注入了别的开关：${inner}`).toBe(true)
    }
    // alias 的条件同理，且「演示构建」那一支必须是空对象：非空就意味着精确别名在演示构建里
    // 也生效，把 `@` 的前缀语义改掉了。
    const aliasCondition = code.match(/\.\.\.\(([^?]*?)\s*\?\s*\{\}\s*:/)
    expect(aliasCondition, 'alias 里应有「<条件> ? {} : {精确别名}」的注入').not.toBeNull()
    expect(
      onlyMockEnabled(aliasCondition?.[1] ?? ''),
      `alias 条件掺了别的开关：${aliasCondition?.[1] ?? ''}`,
    ).toBe(true)
  })
})

describe('演示来源的卡 —— 只说明，不跳真实接口页（#304）', () => {
  test('演示来源没有面交页地址：真实订单才拼出真实 id（AC⑥）', () => {
    expect(DEMO_ORDER_HINT).toBe('演示数据，不接入真实交易')
    expect(meetupUrlOf({ id: 't-101', source: 'demo' })).toBeNull()
    expect(meetupUrlOf({ id: 'txn_01jc000000e00800000000002h', source: 'real' })).toBe(
      '/pkg-trade/pages/transaction-meetup/index?id=txn_01jc000000e00800000000002h',
    )
  })

  test('演示来源没有会话页地址；真实数据缺 conversationId 也不跳', () => {
    expect(conversationUrlOf({ conversationId: 'cnv-demo', source: 'demo' })).toBeNull()
    expect(conversationUrlOf({ conversationId: null, source: 'real' })).toBeNull()
    expect(
      conversationUrlOf({ conversationId: 'cnv_01jc000000e008000000000024', source: 'real' }),
    ).toBe('/pkg-social/pages/conversation/index?id=cnv_01jc000000e008000000000024')
  })

  test('组件里没有第二份地址：两条跳转都走 order-links', async () => {
    const code = codeOnly(await orderListSource())
    expect(code).toContain('meetupUrlOf(item)')
    expect(code).toContain('conversationUrlOf(item)')
    // 地址只在 order-links 里拼一次，否则上面两条断言就管不到真实跳转用的那个字符串
    expect(code).not.toContain('/pkg-trade/pages/transaction-meetup/index?id=')
    expect(code).not.toContain('/pkg-social/pages/conversation/index?id=')
  })

  test('blockIfDemo 只认 source === demo：真实卡原样放行，演示卡给一句说明', async () => {
    const body = await sliceFlat(BLOCK_IF_DEMO, OPEN_CONVERSATION)
    expect(body).toContain('if (!isDemoSource(item)) return false')
    expectAfter(
      body,
      'if (!isDemoSource(item)) return false',
      'Taro.showToast(',
      '真实卡直接放行，只有演示卡才提示',
    )
    // 说明文案与演示地址同源（`order-links`），不在这里各写一份
    expect(body).toContain('title: DEMO_ORDER_HINT')
  })

  test('取消交易 / 读评价边：假 id 不打真实写接口', async () => {
    const cancel = await sliceFlat(CANCEL, OPEN_REVIEW)
    expectAfter(cancel, 'if (blockIfDemo(item)) return', 'Taro.showModal(', '演示来源不打取消接口')
    const review = await sliceFlat(OPEN_REVIEW, SUBMIT_REVIEW)
    expectAfter(
      review,
      'if (blockIfDemo(item)) return',
      'fetchMyTransactionReview(',
      '演示来源不打评价接口',
    )
  })
})

describe('订单来源标记 —— 演示 fixture 与契约订单各自可辨（#304）', () => {
  test('演示兜底：后端不可用时退回 fixture，每张卡都自证 source=demo 的假 id', async () => {
    ordersFailure = new Error('request:fail network error')
    const { loadOrders } = await import('../src/features/fetchers')
    const result = await loadOrders('buyer')

    expect(result.failureKind).toBeNull()
    expect(result.items.length).toBeGreaterThan(0)
    for (const item of result.items) {
      expect(item.source).toBe('demo')
      // 假 id：`t-*` / `l-*` 是 `src/mock/account.ts` 的 TX_SPECS，拿进真实页就是 404
      expect(item.id.startsWith('t-')).toBe(true)
      expect(item.listingId.startsWith('l-')).toBe(true)
    }
  })

  test('契约订单：标 source=real，且 conversationId 原样带出（seed 台灯单的公开 id）', async () => {
    const { toOrderCard } = await import('../src/features/transaction/adapt')
    const { transactionDtoSchema } = await import('@fish/contracts/transactions/schema')
    const { encodePublicId } = await import('@fish/shared/public-id')

    // 字段逐个取自 packages/db/src/seed.ts 的台灯单：交易 transactionLamp（`ids.transactionLamp`，
    // seed.ts:64）、会话 conversationLamp（seed.ts:60，`transactionLamp` 的三元组见 seed.ts:302）、
    // 商品 listingLamp（seed.ts:53，`宿舍护眼台灯` 3000 分 RESERVED）、买家 sellerA（seed.ts:45，阿岚）、
    // 卖家 buyerB（seed.ts:46，小北）。买家视角的对手方就是卖家小北。
    //
    // 这一条只证明**投影不丢字段**：`conversationId` 是原样带出的，不是重算或补空。
    // 「真实 seed 单的 conversationId 非空」的端到端证据是 `GET /transactions?role=seller` 的真实
    // 响应（`cnv_01jc000000e008000000000024`，见 PR 正文 AC⑤ 取证），不是这个手搓 DTO。
    const dto = transactionDtoSchema.parse({
      id: encodePublicId('txn', '01930000-0000-7000-8000-000000000051'),
      conversationId: encodePublicId('cnv', '01930000-0000-7000-8000-000000000044'),
      listingId: encodePublicId('lst', '01930000-0000-7000-8000-000000000014'),
      buyerId: encodePublicId('usr', '01930000-0000-7000-8000-00000000000a'),
      sellerId: encodePublicId('usr', '01930000-0000-7000-8000-00000000000b'),
      role: 'buyer',
      listing: {
        id: encodePublicId('lst', '01930000-0000-7000-8000-000000000014'),
        title: '宿舍护眼台灯',
        priceCents: 3000,
        status: 'RESERVED',
        coverUrl: null,
      },
      counterpart: {
        id: encodePublicId('usr', '01930000-0000-7000-8000-00000000000b'),
        nickname: '小北',
        avatarUrl: null,
      },
      amountCents: 2800,
      status: 'PENDING_MEETUP',
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: '2026-09-14T12:00:00.000Z',
      updatedAt: '2026-09-14T12:00:00.000Z',
    })

    const card = toOrderCard(dto)
    expect(card.source).toBe('real')
    // 字面值 = seed 那两条 UUIDv7 经 `encodePublicId` 的确定性结果，与接口 / 端上看到的一致
    expect(card.id).toBe('txn_01jc000000e00800000000002h')
    expect(card.conversationId).toBe('cnv_01jc000000e008000000000024')
    expect(card.conversationId).toBe(dto.conversationId)
  })
})
