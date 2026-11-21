/**
 * 模型复核的**结果形状与解析**（纯函数，不碰网络与数据库）。
 *
 * 上游是通用对话模型，不是函数调用接口：它可能把 JSON 包在 ```json 围栏里、在正文前后加一句
 * "好的，以下是判断"，也可能直接给出一个既不是 PASS 也不是 BLOCK 的词。这些都在这里被收成
 * 四个取值；**解析失败不等于放行**——`ERROR` 在决策层等价于「转人工」。
 */

/** 模型能表达的四种结论。`UNSURE` 是模型自己的不确定，`ERROR` 是链路/解析失败。 */
export type ModerationReviewDecision = 'PASS' | 'BLOCK' | 'UNSURE' | 'ERROR'

export type ModerationReview = {
  decision: ModerationReviewDecision
  /** 风险类别（自由文本，仅后台可见）。 */
  category: string | null
  /** 判定理由（自由文本，仅后台可见；用户侧只看固定话术）。 */
  reason: string
  /** 模型引用的具体证据（原文摘录/图片描述），仅后台可见。 */
  evidence: string[]
  /** 0–1；模型没给或给得不合法时为 null。 */
  confidence: number | null
}

export class ModerationReviewParseError extends Error {
  constructor(message = '模型返回的复核结论无法解析') {
    super(message)
    this.name = 'ModerationReviewParseError'
  }
}

const MAX_REASON_CHARS = 500
const MAX_EVIDENCE_ITEMS = 10
const MAX_EVIDENCE_CHARS = 300
const MAX_CATEGORY_CHARS = 64

/**
 * 把模型原文解析成结论。
 *
 * 宽容只用在**外层噪声**（围栏、前后缀说明）上，字段本身一律严格：`decision` 不在三个词里就
 * 抛错，而不是"猜一个最近的"——猜错的代价是自动拒绝或自动放行一条真实商品。
 */
export function parseModerationReview(content: string): ModerationReview {
  const json = extractJsonObject(content)
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    throw new ModerationReviewParseError()
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ModerationReviewParseError()
  }
  const record = payload as Record<string, unknown>

  const decision = normalizeDecision(record.decision)
  const reason = readText(record.reason, MAX_REASON_CHARS)
  if (reason === null) throw new ModerationReviewParseError('模型没有给出判定理由')

  return {
    decision,
    category: readText(record.category, MAX_CATEGORY_CHARS),
    reason,
    evidence: readEvidence(record.evidence),
    confidence: readConfidence(record.confidence),
  }
}

/** 调用失败/解析失败时的兜底结论：一定转人工，绝不因为"模型没答上来"而放行。 */
export function errorReview(reason: string): ModerationReview {
  return { decision: 'ERROR', category: null, reason, evidence: [], confidence: null }
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new ModerationReviewParseError()
  return body.slice(start, end + 1)
}

function normalizeDecision(value: unknown): ModerationReviewDecision {
  if (typeof value !== 'string') throw new ModerationReviewParseError('模型没有给出 decision')
  const normalized = value.trim().toUpperCase()
  if (normalized === 'PASS' || normalized === 'BLOCK' || normalized === 'UNSURE') return normalized
  throw new ModerationReviewParseError(`模型给出了未知 decision：${normalized.slice(0, 20)}`)
}

function readText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, maxChars)
}

function readEvidence(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
      .slice(0, MAX_EVIDENCE_ITEMS)
      .map((item) => item.slice(0, MAX_EVIDENCE_CHARS))
  }
  const single = readText(value, MAX_EVIDENCE_CHARS)
  return single === null ? [] : [single]
}

function readConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // 有的模型给 0–100 的百分数；两种都收，越界当没给。
  const normalized = value > 1 && value <= 100 ? value / 100 : value
  if (normalized < 0 || normalized > 1) return null
  return normalized
}
