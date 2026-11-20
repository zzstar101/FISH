import { z } from 'zod'
import { WishIdSchema } from '../system/public-id'

/** 许愿墙人工复审队列（#694 M5）。管理员只处理 REVIEW 记录，放行/拒绝都是终态。 */
export const wishModerationQueueItemSchema = z.object({
  id: z.string(),
  wishId: WishIdSchema,
  /** 送审版本：新建待审=1，编辑待审=当前公开版本+1。 */
  contentVersion: z.number().int().positive(),
  keyword: z.string(),
  description: z.string().nullable(),
  /** 当前公开内容（编辑待审时与 keyword/description 不同，供管理员对比）。 */
  currentKeyword: z.string(),
  currentDescription: z.string().nullable(),
  author: z.object({ id: z.string(), nickname: z.string() }),
  machineDecision: z.enum(['ALLOW', 'BLOCK', 'REVIEW']),
  provider: z.enum(['LOCAL', 'TENCENT_TMS', 'TENCENT_IMS']),
  policyVersion: z.string(),
  suggestion: z.string().nullable(),
  score: z.number().int().nullable(),
  matchedRules: z.array(z.string()),
  matchedTermsMasked: z.array(z.string()),
  status: z.enum(['PENDING', 'SETTLED']),
  decision: z.enum(['ALLOW', 'BLOCK']).nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
})
export type WishModerationQueueItem = z.infer<typeof wishModerationQueueItemSchema>

export const wishModerationQueueQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type WishModerationQueueQuery = z.infer<typeof wishModerationQueueQuerySchema>

export const wishModerationQueueResponseSchema = z.object({
  items: z.array(wishModerationQueueItemSchema),
  nextCursor: z.string().nullable(),
})
export type WishModerationQueueResponse = z.infer<typeof wishModerationQueueResponseSchema>

export const wishModerationDecisionInputSchema = z.object({
  decision: z.enum(['ALLOW', 'BLOCK']),
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative(),
})
export type WishModerationDecisionInput = z.infer<typeof wishModerationDecisionInputSchema>

export const wishModerationDecisionResponseSchema = z.object({
  id: z.string(),
  wishId: WishIdSchema,
  decision: z.enum(['ALLOW', 'BLOCK']),
  replayed: z.boolean(),
})

export const WISH_MODERATION_ERROR_CODES = [
  'WISH_MODERATION_NOT_FOUND',
  'WISH_MODERATION_CONFLICT',
  'WISH_MODERATION_INVALID_CURSOR',
  'VALIDATION_FAILED',
] as const
export type WishModerationErrorCode = (typeof WISH_MODERATION_ERROR_CODES)[number]

export const WISH_MODERATION_ROUTES = {
  queue: '/admin/wishes/moderation',
  decision: (recordId: string) => `/admin/wishes/moderation/${recordId}/decision`,
} as const
