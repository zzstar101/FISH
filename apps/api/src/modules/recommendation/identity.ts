import type { InterestIdentity } from '@fish/db/user-interest-store'

/**
 * 推荐域的**身份口径**（#323 R4）。
 *
 * 从 `recall/service.ts` 提出来：R3 时它只是召回层的私有函数（只有一处调用），R4 起排序侧的
 * 负反馈查询要用**同一条**口径，各写一份必然漂移——两边一旦不一致，"召回用的是这个人的兴趣、
 * 惩罚用的是另一个身份的行为"这种 bug 不会报错，只会让效果莫名其妙地差。
 *
 * 规则本身只有两条：
 *
 * 1. **登录身份优先**：有 `userId` 就用它，忽略 `anonymousSessionId`。同一台设备登录后仍会带
 *    着旧的匿名会话 id 上报事件，把两者合并会让"登录前的行为"被当成"这个账号的行为"。
 * 2. **都为空 ⇒ `null`**：没有身份就没有个性化，调用方按冷启动处理（不是错误）。
 */
export type RecommendationIdentityInput = {
  /** 已登录用户（token 真值）。 */
  userId: string | null
  /** 匿名会话 id（客户端自述，仅用于把同一会话的行为串起来）。 */
  anonymousSessionId: string | null
}

export function resolveRecommendationIdentity(
  input: RecommendationIdentityInput,
): InterestIdentity | null {
  if (input.userId !== null) return { kind: 'user', id: input.userId }
  if (input.anonymousSessionId !== null) return { kind: 'anonymous', id: input.anonymousSessionId }
  return null
}
