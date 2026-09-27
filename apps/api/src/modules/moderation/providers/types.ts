/**
 * 内容安全审核 provider 抽象（#228 §5）。
 *
 * 这一层只回答「腾讯 / 本地词表怎么判」，不回答「商品能不能发布」：商品 CREATE/UPDATE 接线、
 * 图片固化与引用、审核记录表都按 #228 的分工另行落地。调用方只看到统一决策
 * （`ModerationDecision`）与统一错误（`ContentModerationError`），不接触 SDK / 签名 / BizType。
 *
 * 对外只暴露 `moderateText` / `moderateImage` 两个异步方法：两者都**只返回判定**，
 * 不写库、不改商品、不动对象存储——业务副作用留给 #228 的接线部分。
 */
import type { ModerationDecision, ModerationField } from '../types'

/** 腾讯 `Suggestion` 的取值；本地 provider 复用同一词汇表，便于两边逐条对照。 */
export const MODERATION_SUGGESTIONS = ['Pass', 'Review', 'Block'] as const
export type ModerationSuggestion = (typeof MODERATION_SUGGESTIONS)[number]

/**
 * 决策来源（#228 §6 审核记录字段）。适配器只产生这三个值；`MANUAL`（人工改判）属记录层，
 * 由 #228 的 Admin 人工队列实现，不在这里预留空值。
 */
export const MODERATION_PROVIDERS = ['LOCAL', 'TENCENT_TMS', 'TENCENT_IMS'] as const
export type ModerationProviderName = (typeof MODERATION_PROVIDERS)[number]

export const MODERATION_TRANSPORTS = ['local', 'tencent'] as const
export type ModerationTransport = (typeof MODERATION_TRANSPORTS)[number]

/**
 * 单字段 / 单张图的判定。
 *
 * `score` 只供审计与调参：腾讯 Score 是「命中该标签的模型置信度」，不同 Label 之间不可比，
 * 因此适配器不做任何 `score > N => block` 的阈值判断（#228 §2）。判定只看 `Suggestion`。
 */
export type ModerationVerdict = {
  decision: ModerationDecision
  suggestion: ModerationSuggestion
  label: string | null
  subLabel: string | null
  score: number | null
  /** 腾讯 `RequestId`（可入日志，已过 `sanitizeRequestId` 白名单）；本地判定为 null。 */
  requestId: string | null
}

export type FieldModerationResult = ModerationVerdict & {
  field: ModerationField
}

export type TextModerationResult = {
  provider: 'LOCAL' | 'TENCENT_TMS'
  transport: ModerationTransport
  /** 调用方传入的业务标识（#217 的 lst_ / usr_ 等）原样回带；provider 不解析其编码。 */
  dataId: string
  /** 策略版本：腾讯 `BizType`，或本地规则版本 `MODERATION_RULE_VERSION`。 */
  policyVersion: string
  /** 字段聚合结果：BLOCK > REVIEW > ALLOW（#228 §2）。 */
  decision: ModerationDecision
  suggestion: ModerationSuggestion
  fields: FieldModerationResult[]
}

export type ImageModerationResult = ModerationVerdict & {
  provider: 'LOCAL' | 'TENCENT_IMS'
  transport: ModerationTransport
  dataId: string
  /** 图片对象键：调用方传入，仅用于回带与追踪；本层不读对象存储（读取由注入的 loader 负责）。 */
  objectKey: string
  policyVersion: string
  /**
   * 图片内容摘要（腾讯 IMS 的 `FileMD5`，已校验为 32 位十六进制并统一小写）。#228 要求
   * 「审核通过后不能用覆盖同一对象的方式替换图片内容」，固化/校验需要这个摘要；腾讯未返回时
   * 为 null（调用方不得把 null 当通过）；非空但不是合法摘要形状时按 `invalid_response` 失败。
   */
  contentDigest: string | null
  /** 无法判定时的原因（本地 provider 不审图片内容时为 `LOCAL_IMAGE_NOT_AUDITED`）。 */
  reasonCode: string | null
}

export type ContentModerationProvider = {
  readonly transport: ModerationTransport
  moderateText(input: {
    dataId: string
    fields: { field: ModerationField; value: string }[]
  }): Promise<TextModerationResult>
  moderateImage(input: { dataId: string; objectKey: string }): Promise<ImageModerationResult>
}

/**
 * 审核失败的统一原因。**没有任何一条映射到 ALLOW**：调用方拿到异常就必须按失败处理
 * （#228 安全条件 1：外部审核失败不放行）。
 */
export const CONTENT_MODERATION_FAILURE_REASONS = [
  /** 上游超时。 */
  'timeout',
  /** 网络/连接层失败。 */
  'network',
  /** 限频（腾讯 `RequestLimitExceeded` 或 HTTP 429）。 */
  'throttled',
  /** 上游 5xx 或 `InternalError` / `FailedOperation`。 */
  'upstream_error',
  /** 上游以非瞬时原因拒绝（其他 4xx / 未知错误码）：重试无意义，但仍不放行。 */
  'upstream_rejected',
  /** 响应非法或字段缺失（含 `Suggestion` 不是 Pass/Review/Block）：无法判定即失败。 */
  'invalid_response',
  /** 入参不合法（dataId 越界、图片过大、无可审内容等）——调用方 bug，重试无意义。 */
  'invalid_input',
  /** 凭据/权限/策略配置错误——重试无意义。 */
  'configuration',
] as const
export type ContentModerationFailureReason = (typeof CONTENT_MODERATION_FAILURE_REASONS)[number]

/** 只重试明确的瞬时故障；其余立刻失败（有限次重试，禁止无上限重试）。 */
const RETRYABLE_REASONS: ReadonlySet<ContentModerationFailureReason> = new Set([
  'timeout',
  'network',
  'throttled',
  'upstream_error',
  'invalid_response',
])

/** 腾讯 `Error.Code` 是枚举串；把非枚举形状的内容挡在日志之外（上游不可信）。 */
const UPSTREAM_CODE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export function sanitizeUpstreamCode(code: unknown): string | null {
  return typeof code === 'string' && UPSTREAM_CODE_PATTERN.test(code) ? code : null
}

/**
 * 腾讯 `RequestId` 与 `Error.Code` 形状相同（字母数字 `._-`），但同样由上游可控，且设计文档
 * 明确允许把它写进日志：#228 §7 只允许记 RequestId，那就不能让上游用换行/控制字符伪造日志行。
 * 不合规一律置 null——宁可丢掉追踪信息，也不把上游文本放出去。
 */
export function sanitizeRequestId(value: unknown): string | null {
  return sanitizeUpstreamCode(value)
}

/**
 * 统一的审核失败错误。
 *
 * 消息**只由本文件按 reason / provider / httpCode / upstreamCode 拼装**，不接受调用方传入的
 * 自由文本：上游返回体可能回显用户原文，SDK 的 `Error.Message` 同样不可信（#228 §7）。
 */
export class ContentModerationError extends Error {
  readonly reason: ContentModerationFailureReason
  readonly provider: ModerationProviderName | null
  /** 已过 `sanitizeRequestId`：非白名单形状（含换行/控制字符）时为 null。 */
  readonly requestId: string | null
  readonly httpCode: number | null
  readonly upstreamCode: string | null
  /** 受控的短标识（枚举风格，非自由文本），用于定位是哪个入参/分支失败。 */
  readonly detail: string | null
  readonly retryable: boolean

  constructor(input: {
    reason: ContentModerationFailureReason
    provider?: ModerationProviderName | null
    requestId?: string | null
    httpCode?: number | null
    upstreamCode?: string | null
    detail?: string | null
  }) {
    const parts = [`reason=${input.reason}`]
    if (input.provider) parts.push(`provider=${input.provider}`)
    if (typeof input.httpCode === 'number') parts.push(`httpCode=${input.httpCode}`)
    const code = sanitizeUpstreamCode(input.upstreamCode)
    if (code) parts.push(`code=${code}`)
    const detail = sanitizeUpstreamCode(input.detail)
    if (detail) parts.push(`detail=${detail}`)
    super(`内容安全审核失败（${parts.join(' ')}）`)
    this.name = 'ContentModerationError'
    this.reason = input.reason
    this.provider = input.provider ?? null
    this.requestId = sanitizeRequestId(input.requestId)
    this.httpCode = typeof input.httpCode === 'number' ? input.httpCode : null
    this.upstreamCode = code
    this.detail = detail
    this.retryable = RETRYABLE_REASONS.has(input.reason)
  }
}

/**
 * 适配器错误 → HTTP 契约（#228 §7）。路由层直接用这个函数，避免各处再抄一遍映射：
 * 审核不可用统一 503 `CONTENT_MODERATION_UNAVAILABLE`；入参不合法是 400。
 *
 * 注意这里**不返回 ALLOW 之类的降级路径**：503 就是 503，调用方不得继续发布。
 */
export function moderationErrorResponse(error: ContentModerationError): {
  status: 400 | 503
  code: 'CONTENT_MODERATION_INVALID_INPUT' | 'CONTENT_MODERATION_UNAVAILABLE'
} {
  if (error.reason === 'invalid_input') {
    return { status: 400, code: 'CONTENT_MODERATION_INVALID_INPUT' }
  }
  return { status: 503, code: 'CONTENT_MODERATION_UNAVAILABLE' }
}

/**
 * 风险优先级（#228 §2）：多字段 / 多图聚合取最高风险。
 *
 * 空数组**抛错而不是返回 ALLOW**：没有判定结果就是没有结论，返回 ALLOW 会变成一条静默放行
 * 路径（两个 provider 都已先用 `invalid_input` 挡掉「没有可审内容」）。未知判定值同样抛错：
 * `DECISION_RANK['BOGUS']` 是 `undefined`，比较会静默落到 ALLOW。
 */
const DECISION_RANK: Record<ModerationDecision, number> = { ALLOW: 0, REVIEW: 1, BLOCK: 2 }

/** 判定值白名单：聚合函数是导出的安全关键路径，来自 DB / 反序列化的字符串不能绕过它。 */
export function isModerationDecision(value: unknown): value is ModerationDecision {
  return value === 'ALLOW' || value === 'REVIEW' || value === 'BLOCK'
}

export function aggregateModerationDecision(
  decisions: readonly ModerationDecision[],
): ModerationDecision {
  if (decisions.length === 0) {
    throw new ContentModerationError({ reason: 'invalid_input', detail: 'no_decision' })
  }
  let highest: ModerationDecision = 'ALLOW'
  for (const decision of decisions) {
    if (!isModerationDecision(decision)) {
      throw new ContentModerationError({ reason: 'invalid_input', detail: 'decision' })
    }
    if (DECISION_RANK[decision] > DECISION_RANK[highest]) highest = decision
  }
  return highest
}

export function isModerationSuggestion(value: unknown): value is ModerationSuggestion {
  return value === 'Pass' || value === 'Review' || value === 'Block'
}

/** 腾讯 `Suggestion` → 统一决策。调用前必须先用 `isModerationSuggestion` 校验。 */
export function decisionFromSuggestion(suggestion: ModerationSuggestion): ModerationDecision {
  if (suggestion === 'Block') return 'BLOCK'
  if (suggestion === 'Review') return 'REVIEW'
  return 'ALLOW'
}

/** 统一决策 → 聚合结果的 `Suggestion`（`TextModerationResult.suggestion` 用）。 */
export function suggestionFromDecision(decision: ModerationDecision): ModerationSuggestion {
  if (decision === 'BLOCK') return 'Block'
  if (decision === 'REVIEW') return 'Review'
  return 'Pass'
}
