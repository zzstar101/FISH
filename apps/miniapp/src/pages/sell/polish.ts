/**
 * 发布页 AI 润色的纯判定（无 Taro、无 mock 依赖：`tests/sell-polish.test.ts` 直接 import）。
 *
 * 与 `./form` 同一取舍：这里只放**屏幕该显示什么**的判定，不放网络调用。
 * 状态机本身留在页面（它要读写 React state），但每个转移的判据都在这里 —— 它们各有
 * 明确的验收口径（#142 / 设计 §10.2），而组件没有测试基建，写在组件里就只能靠人肉 review。
 */
import type { ListingCategory } from '@fish/contracts/listings/schema'

/**
 * 429 的粗粒度阈值（秒）。
 *
 * 命中滚动 24h 配额时 `retryAfterSeconds` 可达数千至上万秒，一律「N 秒后再试」不可读；
 * 而 >60s 的估算本身还带一个已知误差（设计 §5.2「已知近似」），粗粒度文案同时挡住它。
 */
export const POLISH_QUOTA_COARSE_SECONDS = 60

/** 422 的字段级错误已经贴在输入框下方，toast 只负责把用户的视线叫回来。 */
export const POLISH_FIELD_ERROR_TOAST = '有字段没填对，改好再润色'

/**
 * 润色冷却。
 *
 * - `short`：≤60s，逐秒倒计时；
 * - `coarse`：>60s（真实等待可达上万秒），不逐秒，按钮给粗粒度结论；
 * - `unknown`：429 没带秒数（契约里是 `positive().optional()`，只有漂移会出现）——
 *   不知道要等多久，所以既不倒计时、**也不下任何结论**（说「今日次数已用完」是编原因：
 *   服务端三个桶里最可能命中的恰恰是 5s 间隔桶）。
 */
export type PolishCooldown =
  | { kind: 'short'; secondsLeft: number }
  | { kind: 'coarse' }
  | { kind: 'unknown' }

/** 失败出口分类：sheet 内展示 / 关 sheet 落到字段级错误 / 静默交给登录守卫。 */
export type PolishFailureRoute = 'sheet' | 'field-errors' | 'unauthenticated'

/**
 * 失败该往哪条路走。
 *
 * `unauthenticated` 的判据与 `lib/request` 的 `isUnauthenticatedError` 一致（401 + 该码），
 * 不再自己发明一套；`VALIDATION_FAILED` 走字段级错误（`sellFieldErrorsFromDetails`），
 * 不占 sheet 的失败文案 —— 否则同一件事会被说两遍。
 */
export function polishFailureRoute(error: { code: string; status: number }): PolishFailureRoute {
  if (error.status === 401 && error.code === 'UNAUTHENTICATED') return 'unauthenticated'
  if (error.code === 'VALIDATION_FAILED') return 'field-errors'
  return 'sheet'
}

/** sheet 内失败态要渲染的东西。 */
export type PolishFailureView = {
  /** 主文案 */
  message: string
  /** 主文案下的补充说明；`null` = 不渲染 */
  detail: string | null
  /** 是否给「重试」按钮（重试 = 重新请求，会再吃一次配额） */
  canRetry: boolean
}

/**
 * 失败时**原文一字未动**这件事必须说出来（#75「失败可无损返回」）。
 * 只给「上游真的试过了」的几种失败加这句：配额、未开放、422 都还没轮到调用上游，
 * 说它反而像在解释别的。
 */
const UNCHANGED = '你的描述没有改动'

/**
 * 失败码 → 文案。
 *
 * 用 `Map` 而不是对象字面量：`code` 是**服务端可控的字符串**（`lib/request.ts` 直接透出信封里的
 * `error.code`，契约只约束它是 string），而 `({})['toString']` 取到的是 `Object.prototype` 上的
 * 函数 —— `?? FALLBACK` 不会兜住它，页面会渲染出一张主文案为空、也没有「重试」的失败 sheet。
 * `Map.get` 对这些键一律返回 `undefined`。（不用 `Object.hasOwn`：小程序运行时不一定有 ES2022。）
 */
const FAILURE_VIEWS = new Map<string, PolishFailureView>([
  ['AI_TIMEOUT', { message: '润色超时了，重试一下', detail: UNCHANGED, canRetry: true }],
  [
    'AI_UPSTREAM_ERROR',
    { message: '润色服务暂时不可用，稍后再试', detail: UNCHANGED, canRetry: true },
  ],
  [
    'AI_RESULT_EMPTY',
    {
      message: '这次没生成可用的文案',
      detail: '你的描述没有改动，可以自己再改改',
      canRetry: true,
    },
  ],
  /**
   * 422 只在**字段级错误一个都认不出来**时才走到这里（认得出就关 sheet 去标红输入框了）：
   * 这条文案不能指向具体字段（没有任何字段被标红），也不给「重试」（同样的入参再发一次还是 422）。
   */
  ['VALIDATION_FAILED', { message: '有些内容没填对，请检查后再试', detail: null, canRetry: false }],
  // 正常启动的进程里走不到（`loadAiPolishEnv` 在 baseUrl 为空时启动即失败），
  // 文案仍按契约写全：它是运行期兜底，不是死代码。
  ['AI_NOT_CONFIGURED', { message: '润色功能暂未开放', detail: null, canRetry: false }],
])

/**
 * 枚举外的兜底（网络异常、契约外的码）。
 *
 * 契约只冻结了六个码，但 `apiRequest` 在网络层失败时抛的不是 `ApiError`，
 * 页面不能因此什么都不显示。
 */
const FALLBACK_FAILURE_VIEW: PolishFailureView = {
  message: '润色失败，稍后再试',
  detail: UNCHANGED,
  canRetry: true,
}

/** 429 的 sheet 文案。**不透露日配额数字**（设计 §10.2）：只给等待时间或粗粒度结论。 */
export function polishQuotaMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return '操作太频繁，稍后再试'
  if (retryAfterSeconds > POLISH_QUOTA_COARSE_SECONDS) return '今天的润色次数用完了，明天再来'
  return `操作太频繁，${retryAfterSeconds} 秒后再试`
}

/** 失败码 → sheet 内文案。`retryAfterSeconds` 只有 429 用得上。 */
export function polishFailureView(code: string, retryAfterSeconds?: number): PolishFailureView {
  if (code === 'AI_POLISH_QUOTA') {
    return { message: polishQuotaMessage(retryAfterSeconds), detail: null, canRetry: false }
  }
  return FAILURE_VIEWS.get(code) ?? FALLBACK_FAILURE_VIEW
}

/**
 * 429 → 冷却态。
 *
 * 秒数缺失或非正数退到 `unknown`：**仍然不编一个数字**，但按钮照样变灰 —— 需求要防的是
 * 「被拒了还能接着点、每点一次再吃一次 429」这个循环，而按钮上的字只说「请稍后再试」，
 * 不声称是日配额用完了（那正是没有依据的推断）。
 */
export function polishCooldownFrom(retryAfterSeconds: number | undefined): PolishCooldown {
  if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) return { kind: 'unknown' }
  return retryAfterSeconds > POLISH_QUOTA_COARSE_SECONDS
    ? { kind: 'coarse' }
    : { kind: 'short', secondsLeft: retryAfterSeconds }
}

/**
 * 走一秒。`null` = 冷却结束、按钮恢复可点。
 *
 * `coarse` / `unknown` 都原样返回：它们本来就不逐秒，也不在本次页面生命周期内自动解禁
 * （重进页面即复位，服务端始终是权威）。
 */
export function tickPolishCooldown(cooldown: PolishCooldown): PolishCooldown | null {
  if (cooldown.kind !== 'short') return cooldown
  return cooldown.secondsLeft <= 1 ? null : { kind: 'short', secondsLeft: cooldown.secondsLeft - 1 }
}

/** 入口按钮上的字。冷却时按钮已被守卫挡住，这里只负责把原因说清楚。 */
export function polishButtonText(input: {
  loading: boolean
  cooldown: PolishCooldown | null
}): string {
  if (input.loading) return '润色中'
  if (input.cooldown?.kind === 'short') return `${input.cooldown.secondsLeft}s`
  if (input.cooldown?.kind === 'coarse') return '今日次数已用完'
  if (input.cooldown?.kind === 'unknown') return '请稍后再试'
  return '润色'
}

/**
 * 「换一条」的索引。**纯前端轮播**，不重新请求、不消耗配额（设计 §12-3）。
 *
 * 契约保证候选 1~3 条，`count <= 0` 只是防御：`% 0` 会得到 `NaN`，
 * 渲染时变成「第 NaN / 0 条」。
 */
export function nextPolishIndex(current: number, count: number): number {
  if (count <= 0) return 0
  return (current + 1) % count
}

/**
 * 点「润色」之前的本地拦截。
 *
 * 三件事都会被服务端独立拒掉（`AiPolishCandidatesRequestSchema` 的 title / description /
 * category 全是必填），这里拦只是少打一次注定 422 的请求 —— 服务端校验不因此失效。
 * 顺序照「用户正对着哪个输入框」排：润色按钮在描述框里，所以描述排第一。
 */
export function polishPreconditionError(input: {
  title: string
  description: string
  category: ListingCategory | null
}): string | null {
  if (input.description.trim().length === 0) return '先写一句描述再润色'
  if (input.title.trim().length < 2) return '标题至少 2 个字再润色'
  if (!input.category) return '先选好分类再润色'
  return null
}
