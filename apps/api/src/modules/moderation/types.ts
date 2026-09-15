export const MODERATION_DECISIONS = ['ALLOW', 'BLOCK', 'REVIEW'] as const
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number]

export type ModerationField = 'title' | 'description'

export type ModerationMatch = {
  field: ModerationField
  ruleCode: string
  /** 脱敏后的命中片段，不返回完整词库内容。 */
  maskedTerm: string
}

export type ModerationResult = {
  decision: ModerationDecision
  matches: ModerationMatch[]
  reasonCode: string | null
  ruleVersion: string
}
