import { AdminModerationModelReviewSchema } from '@fish/contracts/admin/schema'
import { ListingCategorySchema } from '@fish/contracts/listings/schema'
import { ModerationDecisionSchema } from '@fish/contracts/moderation/schema'
import { z } from 'zod'
import { ListingIdSchema, ModerationRecordIdSchema, UserIdSchema } from '../system/public-id'

/**
 * 飞书审核台（fish-ops 的 AstrBot 插件）与 API 之间的协议。
 *
 * 这条通道**不给普通管理员用**：它用静态 token 认证，只暴露「拉待审商品」与「通过/拒绝」两件事，
 * 能力边界比 `/admin/*` 窄得多。管理员后台仍然走会话登录 + 角色校验。
 *
 * 为什么不复用 `AdminModerationQueueItem`：机器人卡片要展示价格、类目、图片和模型结论，
 * 而这些字段 admin 队列里没有；把它们塞进 admin 契约会让「后台队列长什么样」被机器人的
 * 需要牵着走。两边的**判定语义**仍然共用同一个 service（`decideModeration`），不各写一套。
 */

export const ModerationBotImageSchema = z.object({
  url: z.string().min(1),
  /** 商品图片里的顺序，1 起。卡片按这个顺序展示。 */
  position: z.number().int().min(1),
})
export type ModerationBotImage = z.infer<typeof ModerationBotImageSchema>

export const ModerationBotItemSchema = z.object({
  /** 机器判 REVIEW 的那条记录（`decideModeration` 的入参）。 */
  recordId: ModerationRecordIdSchema,
  listingId: ListingIdSchema,
  title: z.string(),
  description: z.string(),
  priceCents: z.number().int().nonnegative(),
  category: ListingCategorySchema,
  sellerId: UserIdSchema,
  sellerNickname: z.string(),
  machineDecision: ModerationDecisionSchema,
  /** 上游来源与原始标签，语义同 admin 契约（见 `AdminModerationProviderSchema` 的说明）。 */
  provider: z.enum(['LOCAL', 'TENCENT_TMS', 'TENCENT_IMS', 'MANUAL']).nullable(),
  label: z.string().nullable(),
  subLabel: z.string().nullable(),
  score: z.number().nullable(),
  /** 最多前几张的签名 URL；`imageCount` 是总数，卡片据此提示「共 N 张」。 */
  images: z.array(ModerationBotImageSchema),
  imageCount: z.number().int().nonnegative(),
  modelReview: AdminModerationModelReviewSchema.nullable(),
  createdAt: z.iso.datetime(),
})
export type ModerationBotItem = z.infer<typeof ModerationBotItemSchema>

export const ModerationBotQueueSchema = z.object({
  items: z.array(ModerationBotItemSchema),
})
export type ModerationBotQueue = z.infer<typeof ModerationBotQueueSchema>

export const ModerationBotDecisionInputSchema = z.strictObject({
  decision: z.enum(['ALLOW', 'BLOCK']),
  /** 不填就用默认话术；卡片上不需要人工写理由。 */
  reason: z.string().trim().min(1).max(500).optional(),
})
export type ModerationBotDecisionInput = z.infer<typeof ModerationBotDecisionInputSchema>

export const ModerationBotDecisionResultSchema = z.object({
  recordId: ModerationRecordIdSchema,
  decision: z.enum(['ALLOW', 'BLOCK']),
})
export type ModerationBotDecisionResult = z.infer<typeof ModerationBotDecisionResultSchema>
