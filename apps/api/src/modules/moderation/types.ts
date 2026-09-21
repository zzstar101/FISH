export const MODERATION_DECISIONS = ['ALLOW', 'BLOCK', 'REVIEW'] as const
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number]

export type ModerationField = 'title' | 'description'

export type ModerationMatch = {
  field: ModerationField
  ruleCode: string
  /**
   * **该条规则本身**的判定强度（不等于整次审核的 `decision`）。
   *
   * 一次提交可以同时命中 BLOCK 与 REVIEW 规则，而 `ModerationResult.decision` 只保留最高档；
   * 调用方要按字段给用户解释「为什么被拦下」时必须回到这一项，否则会把只触发 REVIEW 的字段
   * 也报成「禁止发布的内容」（#74）。
   */
  decision: 'BLOCK' | 'REVIEW'
  /** 脱敏后的命中片段，不返回完整词库内容。 */
  maskedTerm: string
}

export type ModerationResult = {
  decision: ModerationDecision
  matches: ModerationMatch[]
  reasonCode: string | null
  ruleVersion: string
}
