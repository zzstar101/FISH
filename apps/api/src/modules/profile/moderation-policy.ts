import type {
  ContentModerationProvider,
  ModerationProviderName,
  ModerationSuggestion,
  TextModerationResult,
} from '../moderation/providers/types'

/**
 * 昵称 / 签名送审的字段名（#694 M5）。
 *
 * 两个字段**必须分开送**：local provider 把 `fields` 收成 `Object.fromEntries`，同名字段
 * 会互相覆盖，剩下那个等于没审。腾讯侧字段名只进 `DataId` 后缀，不上送原文。
 */
export type ProfileTextField = 'nickname' | 'signature'

/** 昵称 / 签名审核结果（#694 M5）。摊平后直接写 `profile_moderation_records`。 */
export interface ProfileTextModerationResult {
  decision: TextModerationResult['decision']
  provider: ModerationProviderName
  policyVersion: string
  providerRequestId: string | null
  suggestion: ModerationSuggestion
  label: string | null
  subLabel: string | null
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
  /** 被判 BLOCK 的具体字段：只有它们该报「包含平台禁止发布的内容」（其余字段可能只是 REVIEW）。 */
  blockedFields: ProfileTextField[]
}

export interface ProfileModerationPolicy {
  /**
   * 只审**本次真正变化**的文本字段；`undefined` 表示该字段没变（不送审，也不当成空值）。
   * 没有可审字段时调用方不会调用本方法（provider 会以 `invalid_input/no_content` 拒绝）。
   */
  moderateProfile(input: {
    nickname?: string
    signature?: string
  }): Promise<ProfileTextModerationResult>
}

const dataId = () => `profile-${crypto.randomUUID()}`

function maxScore(fields: TextModerationResult['fields']): number | null {
  const scores = fields.flatMap((field) => (field.score === null ? [] : [field.score]))
  return scores.length === 0 ? null : Math.max(...scores)
}

/**
 * 公开 UGC 文本审核策略（#694 M5 昵称/签名）。复用 `ContentModerationProvider` 的
 * 签名 / 超时 / 重试与错误分类，只负责把资料字段映射成 provider 的 `fields` 并把结论摊平。
 *
 * BizType 由 provider 的配置决定：装配处传入 `TENCENT_TMS_UGC_BIZ_TYPE`，与商品 / 聊天
 * 策略号隔离（同一套词表与阈值换策略号 = 换了审核口径，不能共用）。
 */
export function createProfileModerationPolicy(
  provider: ContentModerationProvider,
): ProfileModerationPolicy {
  return {
    async moderateProfile({ nickname, signature }) {
      const fields: { field: ProfileTextField; value: string }[] = []
      if (nickname !== undefined) fields.push({ field: 'nickname', value: nickname })
      if (signature !== undefined) fields.push({ field: 'signature', value: signature })

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
        blockedFields: result.fields
          .filter((field) => field.decision === 'BLOCK')
          .map((field) => field.field)
          .filter(
            (field): field is ProfileTextField => field === 'nickname' || field === 'signature',
          ),
      }
    },
  }
}
