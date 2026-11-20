export const MODERATION_DECISIONS = ['ALLOW', 'BLOCK', 'REVIEW'] as const
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number]

/**
 * 可送审的字段。商品是 title/description（#228），聊天正文是 content（#694 M1），
 * 公开 UGC 正文是 publicContent，用户昵称 / 个性签名是 nickname/signature（#694 M5）——
 * provider 不关心字段的业务含义，只按字段逐个回带结论。
 *
 * 昵称与签名**必须是两个不同的字段名**：local provider 会把 `fields` 收成
 * `Object.fromEntries`，同名字段互相覆盖，被覆盖的那个字段等于没审。
 */
export type ModerationField =
  | 'title'
  | 'description'
  | 'content'
  | 'publicContent'
  | 'nickname'
  | 'signature'

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
