import { z } from 'zod'

/**
 * Match Engine 的 job payload 契约（Issue #8）。
 *
 * 生产者：#6 的商品创建/重复发布写 `MATCH_LISTING`（`apps/api/src/modules/listings/store.ts`
 * 的 `enqueueMatchJob`），#7 的愿望创建写 `MATCH_WISH`（目前是 noop 队列，见 #8 契约评论 §6.1）。
 * 消费者：`apps/worker/src/jobs/matching/**`。
 */

/**
 * job 类型常量。**与 `packages/db/src/schema/jobs.ts:8` 的 `JobType` 联合是两份**：
 * `packages/db` 没有（也不该有）`@fish/contracts` 依赖，所以只能靠这条注释同步——
 * 加新 job 类型时两处都要改。
 */
export const MATCH_JOB_TYPES = { listing: 'MATCH_LISTING', wish: 'MATCH_WISH' } as const

/**
 * `.strictObject()`：worker 收到多余字段或类型不符就应当判这个 job 坏掉
 * （`FAILED` + `last_error`），而不是静默忽略一个自己没读懂的 payload。
 *
 * 字段形状与 #6 已在写的 `{ listingId }` 逐字一致。
 */
export const MatchListingJobPayloadSchema = z.strictObject({ listingId: z.uuid() })

export const MatchWishJobPayloadSchema = z.strictObject({ wishId: z.uuid() })

export type MatchListingJobPayload = z.infer<typeof MatchListingJobPayloadSchema>
export type MatchWishJobPayload = z.infer<typeof MatchWishJobPayloadSchema>
