import { z } from 'zod'

/**
 * 推荐域 job（#323 R2 — User Interest Profile）。
 *
 * 与 `MATCH_*` / `EMBED_*` 分开：画像重算是"行为聚合"这条链，它与语义匹配、向量生成各自的失败
 * 模式完全不同（前者不依赖外部 provider、只依赖 DB 与纯计算），混在一个 handler 表里会让一类
 * 失败把另一类打成 FAILED。
 *
 * payload 只带 `userId`：长期画像的定义是"该用户近 180 天行为的聚合"，any 时刻重算都必须读
 * **当时的**事件与向量，所以 job 里不能携带窗口、事件 id 或向量快照——晚到的旧 job 因此天然
 * 幂等（重算结果由当前数据决定，不由 job 入队时刻决定）。
 *
 * 与 `packages/db/src/schema/jobs.ts` 的 `JobType` 是两份：这里加类型时那里也要加。
 */
export const RECOMMENDATION_JOB_TYPES = {
  refreshUserInterest: 'REFRESH_USER_INTEREST',
} as const

export type RecommendationJobType =
  (typeof RECOMMENDATION_JOB_TYPES)[keyof typeof RECOMMENDATION_JOB_TYPES]

export const RefreshUserInterestJobPayloadSchema = z.strictObject({ userId: z.uuid() })

export type RefreshUserInterestJobPayload = z.infer<typeof RefreshUserInterestJobPayloadSchema>
