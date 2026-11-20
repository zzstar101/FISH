import { z } from 'zod'
import { ProfileModerationRecordIdSchema, UserIdSchema } from '../system/public-id'

/**
 * 用户资料（昵称 / 个性签名 / 头像）人工复审队列（#694 M5）。
 *
 * 与许愿待审队列同形：只列 `PENDING` 记录，管理员放行 / 拒绝都是终态。
 * 区别在于**放行的副作用**——许愿记录改的是愿望行，这里改的是 `users` 的公开列，
 * 因此队列项同时给出「待审值」与「当前公开值」，管理员能直接对比。
 */
export const profileModerationQueueItemSchema = z.object({
  id: ProfileModerationRecordIdSchema,
  userId: UserIdSchema,
  /**
   * 本次提交里**待审**的昵称 / 签名 / 头像；`null` 表示该字段不在本次提交中。
   * `fields` 明确列出本次提交涉及的字段，用它区分「没提交签名」与「提交了清空签名」。
   */
  nickname: z.string().nullable(),
  signature: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  fields: z.array(z.enum(['nickname', 'signature', 'avatarUrl'])),
  /** 当前正在对外展示的公开值（放行前用户仍显示它）。 */
  currentNickname: z.string(),
  currentSignature: z.string().nullable(),
  currentAvatarUrl: z.url().nullable(),
  author: z.object({ id: UserIdSchema, nickname: z.string() }),
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
export type ProfileModerationQueueItem = z.infer<typeof profileModerationQueueItemSchema>

export const profileModerationQueueQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type ProfileModerationQueueQuery = z.infer<typeof profileModerationQueueQuerySchema>

export const profileModerationQueueResponseSchema = z.object({
  items: z.array(profileModerationQueueItemSchema),
  nextCursor: z.string().nullable(),
})
export type ProfileModerationQueueResponse = z.infer<typeof profileModerationQueueResponseSchema>

/**
 * 人工决定。`version` 是读取队列项时拿到的乐观锁版本：
 * 管理员看到的内容与提交决定之间若已被别人处理（或用户又改了一次资料），服务端 409，
 * 绝不用过期的判断去批准最新的内容。
 */
export const profileModerationDecisionInputSchema = z.object({
  decision: z.enum(['ALLOW', 'BLOCK']),
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative(),
})
export type ProfileModerationDecisionInput = z.infer<typeof profileModerationDecisionInputSchema>

export const profileModerationDecisionResponseSchema = z.object({
  id: ProfileModerationRecordIdSchema,
  userId: UserIdSchema,
  decision: z.enum(['ALLOW', 'BLOCK']),
  /** 同结论重复提交时为 true：放行只切换一次公开值。 */
  replayed: z.boolean(),
})

export const PROFILE_MODERATION_ERROR_CODES = [
  'PROFILE_MODERATION_NOT_FOUND',
  'PROFILE_MODERATION_CONFLICT',
  'PROFILE_MODERATION_INVALID_CURSOR',
  'VALIDATION_FAILED',
] as const
export type ProfileModerationErrorCode = (typeof PROFILE_MODERATION_ERROR_CODES)[number]

export const PROFILE_MODERATION_ROUTES = {
  queue: '/admin/profile/moderation',
  decision: (recordId: string) => `/admin/profile/moderation/${recordId}/decision`,
} as const
