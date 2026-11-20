import type { ContentModerationProvider, TextModerationResult } from '../moderation/providers/types'

/** 许愿墙文本审核结果（#694 M5）。字段摊平后直接写 `wish_moderation_records`。 */
export interface WishTextModerationResult {
  decision: TextModerationResult['decision']
  provider: TextModerationResult['provider']
  policyVersion: string
  providerRequestId: string | null
  suggestion: TextModerationResult['suggestion']
  label: string | null
  subLabel: string | null
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
}

export interface WishModerationPolicy {
  moderateWish(input: {
    keyword: string
    description: string | null
  }): Promise<WishTextModerationResult>
}

const dataId = () => `wish-${crypto.randomUUID()}`

function maxScore(fields: TextModerationResult['fields']): number | null {
  const scores = fields.flatMap((field) => (field.score === null ? [] : [field.score]))
  return scores.length === 0 ? null : Math.max(...scores)
}

/**
 * 公开 UGC 文本审核策略（#694 M5）。复用 ContentModerationProvider 的签名/重试/超时，
 * 只负责把许愿墙字段映射成 provider 的 `fields` 并把结论摊平；BizType 由 provider 配置
 * （TENCENT_TMS_UGC_BIZ_TYPE）保证与商品/聊天隔离。
 */
export function createWishModerationPolicy(
  provider: ContentModerationProvider,
): WishModerationPolicy {
  return {
    async moderateWish({ keyword, description }) {
      const fields: { field: 'title' | 'description'; value: string }[] = [
        { field: 'title', value: keyword },
      ]
      if (description !== null && description.trim() !== '') {
        fields.push({ field: 'description', value: description })
      }
      const result = await provider.moderateText({ dataId: dataId(), fields })
      const matchedRules = [
        ...new Set(result.fields.flatMap((field) => (field.subLabel ? [field.subLabel] : []))),
      ]
      const matchedTermsMasked = [
        ...new Set(result.fields.flatMap((field) => field.maskedTerms ?? [])),
      ]
      return {
        decision: result.decision,
        provider: result.provider,
        policyVersion: result.policyVersion,
        providerRequestId:
          result.fields.find((field) => field.requestId !== null)?.requestId ?? null,
        suggestion: result.suggestion,
        label: result.fields.find((field) => field.label !== null)?.label ?? null,
        subLabel: result.fields.find((field) => field.subLabel !== null)?.subLabel ?? null,
        score: maxScore(result.fields),
        matchedRules,
        matchedTermsMasked,
      }
    },
  }
}
