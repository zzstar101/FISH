import { z } from 'zod'

/**
 * 视觉回填 job（#324 M8）的任务类型与 payload 契约。
 *
 * 与 #322 的 `embedding/jobs.ts` 同形，但**只有一个实体**：只有 Listing 有封面图，
 * 愿望没有图片输入，所以这里不预先造一个 `wish` 分支（不做假想抽象）。
 *
 * payload 只放 id：图片、模型版本都在 handler 运行时现查，避免 payload 与实体行漂移
 * （旧 job 晚到时必须按**当前**封面重算，而不是按入队那一刻的封面）。
 */
export const VISUAL_EMBED_JOB_TYPES = {
  listing: 'VISUAL_EMBED_LISTING',
} as const

export type VisualEmbedJobType =
  (typeof VISUAL_EMBED_JOB_TYPES)[keyof typeof VISUAL_EMBED_JOB_TYPES]

export const VisualEmbedListingJobPayloadSchema = z.strictObject({
  listingId: z.uuid(),
})

export type VisualEmbedListingJobPayload = z.infer<typeof VisualEmbedListingJobPayloadSchema>
