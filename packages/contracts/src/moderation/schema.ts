import { z } from 'zod'
import { ListingIdSchema, ModerationRecordIdSchema, UserIdSchema } from '../system/public-id'

/** Moderation Domain Contract（#80 / Admin #73）。机器审核与人工决定共用同一结果值域。 */
export const ModerationDecisionSchema = z.enum(['ALLOW', 'BLOCK', 'REVIEW'])
export type ModerationDecision = z.infer<typeof ModerationDecisionSchema>

export const ModerationStatusSchema = z.enum(['APPROVED', 'BLOCKED', 'REVIEW'])
export type ModerationStatus = z.infer<typeof ModerationStatusSchema>

export const ModerationRecordSchema = z.object({
  id: ModerationRecordIdSchema,
  listingId: ListingIdSchema.nullable(),
  sellerId: UserIdSchema,
  action: z.string().min(1),
  titleSnapshot: z.string(),
  descriptionSnapshot: z.string(),
  decision: ModerationDecisionSchema,
  matchedRules: z.array(z.string()),
  matchedTermsMasked: z.array(z.string()),
  ruleVersion: z.string().min(1),
  createdAt: z.iso.datetime(),
})
export type ModerationRecord = z.infer<typeof ModerationRecordSchema>

export const ModerationQueueItemSchema = z.object({
  record: ModerationRecordSchema,
  listing: z.object({
    id: ListingIdSchema,
    title: z.string(),
    description: z.string(),
    status: z.enum(['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE']),
    moderationStatus: ModerationStatusSchema,
    moderationReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
  seller: z.object({
    id: UserIdSchema,
    nickname: z.string(),
  }),
})
export type ModerationQueueItem = z.infer<typeof ModerationQueueItemSchema>

export const ModerationQueueResponseSchema = z.object({
  items: z.array(ModerationQueueItemSchema),
  nextCursor: z.string().nullable(),
})
export type ModerationQueueResponse = z.infer<typeof ModerationQueueResponseSchema>

export const ModerationDetailSchema = z.object({
  record: ModerationRecordSchema,
  listing: ModerationQueueItemSchema.shape.listing,
  seller: ModerationQueueItemSchema.shape.seller,
  history: z.array(ModerationRecordSchema),
  /** 机器结果与人工最终决定分层展示；人工未处理时为 null。 */
  machineDecision: ModerationDecisionSchema.nullable(),
  humanDecision: z
    .object({
      decision: z.enum(['ALLOW', 'BLOCK']),
      reason: z.string(),
      actor: z.object({ id: UserIdSchema, nickname: z.string() }).nullable(),
      decidedAt: z.iso.datetime(),
    })
    .nullable(),
})
export type ModerationDetail = z.infer<typeof ModerationDetailSchema>

export const ModerationDecisionInputSchema = z.strictObject({
  decision: z.enum(['ALLOW', 'BLOCK']),
  reason: z.string().trim().min(1).max(500),
})
export type ModerationDecisionInput = z.infer<typeof ModerationDecisionInputSchema>

export const ModerationQueueQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type ModerationQueueQuery = z.infer<typeof ModerationQueueQuerySchema>
