import { z } from 'zod'

/**
 * embedding 生成 job（#322 M1）。
 *
 * 与 MATCH_* 刻意分开：provider 失败、超时、限流只影响这一条生成链，不会把匹配 job 一起
 * 打成 FAILED。payload 只带实体 id —— 文本与内容指纹由 handler 在**运行时**重新读实体生成
 * （见 `apps/worker/src/jobs/embedding/handlers.ts`），所以晚到的旧 job 也只会拿最新内容算，
 * 结构上不可能用旧内容覆盖新向量。
 *
 * 与 `packages/db/src/schema/jobs.ts` 的 `JobType` 是两份：这里加类型时那里也要加。
 */
export const EMBED_JOB_TYPES = {
  listing: 'EMBED_LISTING',
  wish: 'EMBED_WISH',
} as const

export type EmbedJobType = (typeof EMBED_JOB_TYPES)[keyof typeof EMBED_JOB_TYPES]

export const EmbedListingJobPayloadSchema = z.strictObject({ listingId: z.uuid() })
export const EmbedWishJobPayloadSchema = z.strictObject({ wishId: z.uuid() })

export type EmbedListingJobPayload = z.infer<typeof EmbedListingJobPayloadSchema>
export type EmbedWishJobPayload = z.infer<typeof EmbedWishJobPayloadSchema>
