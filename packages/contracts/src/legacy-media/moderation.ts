import { z } from 'zod'
import { LegacyMediaAuditItemIdSchema, ListingIdSchema, UserIdSchema } from '../system/public-id'

/**
 * 存量图片补审的人工复核队列（#694 审查 P1-2）。
 *
 * 来源不只有商品图：`finalizeLegacyMediaAudit` 对评价图 / 聊天图同样会写入 `REVIEW`，
 * 这些来源没有独立的管理端队列，所以统一在这里按审计记录 id 列出与处理。
 *
 * **不暴露 `objectKey`**：队列只说明「有图可读」以及 MIME / 大小 / 摘要，字节走带管理员
 * 鉴权的 `GET .../:id/media`，存储布局不扩散到客户端。
 */
export const LegacyMediaAuditSourceKindSchema = z.enum(['LISTING', 'REVIEW', 'CHAT'])
export type LegacyMediaAuditSourceKind = z.infer<typeof LegacyMediaAuditSourceKindSchema>

export const LegacyMediaAuditVisibilitySchema = z.enum([
  'PUBLIC_DIRECT',
  'LEGACY_PROXY',
  'PRIVATE_PROXY',
  'PRIVATE',
])
export type LegacyMediaAuditVisibility = z.infer<typeof LegacyMediaAuditVisibilitySchema>

export const LegacyMediaAuditStatusSchema = z.enum(['PENDING', 'AUDITED', 'FAILED'])
export type LegacyMediaAuditStatus = z.infer<typeof LegacyMediaAuditStatusSchema>
/** 机器补审的原始结论（队列只收 REVIEW，保留三值便于排查）。 */
export const LegacyMediaAuditMachineDecisionSchema = z.enum(['ALLOW', 'BLOCK', 'REVIEW'])
export type LegacyMediaAuditMachineDecision = z.infer<typeof LegacyMediaAuditMachineDecisionSchema>
/** 人工可以下达的结论。 */
export const LegacyMediaAuditDecisionSchema = z.enum(['ALLOW', 'BLOCK'])
export type LegacyMediaAuditDecision = z.infer<typeof LegacyMediaAuditDecisionSchema>

export const LegacyMediaAuditProviderSchema = z.enum(['LOCAL', 'TENCENT_IMS'])
export type LegacyMediaAuditProvider = z.infer<typeof LegacyMediaAuditProviderSchema>
export const LegacyMediaAuditSuggestionSchema = z.enum(['Pass', 'Review', 'Block'])
export type LegacyMediaAuditSuggestion = z.infer<typeof LegacyMediaAuditSuggestionSchema>

export const LegacyMediaAuditItemSchema = z.object({
  /** 补审记录公开 ID（`lma_`）。 */
  id: LegacyMediaAuditItemIdSchema,
  sourceKind: LegacyMediaAuditSourceKindSchema,
  /** 盘点时命中的业务表（`listing_images` / `transaction_review_images` / `message_media`）。 */
  sourceTable: z.string().min(1).max(64),
  owner: z.object({ id: UserIdSchema, nickname: z.string() }).nullable(),
  /**
   * 商品来源的展示摘要；评价图 / 聊天图来源为 `null`。
   * 只给标题与状态，不给对象键或图片字节。
   */
  listing: z
    .object({
      id: ListingIdSchema,
      title: z.string(),
      status: z.string(),
      moderationStatus: z.string(),
    })
    .nullable(),
  counts: z.object({
    owners: z.number().int().min(1),
    references: z.number().int().min(1),
    listings: z.number().int().min(0),
  }),
  /** 盘点时看到的公开读面，决定补审期间要收口哪条路径。 */
  visibility: LegacyMediaAuditVisibilitySchema,
  media: z.object({
    contentType: z.string().nullable(),
    sizeBytes: z.number().int().positive().nullable(),
    /** 送审字节的 sha256；管理员可据此确认媒体端点返回的是同一份内容。 */
    contentDigest: z.string().nullable(),
  }),
  audit: z.object({
    status: LegacyMediaAuditStatusSchema,
    decision: LegacyMediaAuditMachineDecisionSchema.nullable(),
    provider: LegacyMediaAuditProviderSchema.nullable(),
    providerRequestId: z.string().nullable(),
    policyVersion: z.string().nullable(),
    suggestion: LegacyMediaAuditSuggestionSchema.nullable(),
    label: z.string().nullable(),
    subLabel: z.string().nullable(),
    score: z.number().min(0).max(100).nullable(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    auditedAt: z.iso.datetime().nullable(),
  }),
  /** 乐观并发版本：提交决定时必须回传，过期返回 409。 */
  version: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
})
export type LegacyMediaAuditItem = z.infer<typeof LegacyMediaAuditItemSchema>

export const LegacyMediaAuditQueueQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type LegacyMediaAuditQueueQuery = z.infer<typeof LegacyMediaAuditQueueQuerySchema>

export const LegacyMediaAuditQueueResponseSchema = z.object({
  items: z.array(LegacyMediaAuditItemSchema),
  nextCursor: z.string().nullable(),
})
export type LegacyMediaAuditQueueResponse = z.infer<typeof LegacyMediaAuditQueueResponseSchema>

/**
 * 人工放行 / 拒绝。`version` 是读详情时拿到的版本：期间被别人改过就 409，
 * 绝不用过期判断去改变一张图的公开可见性。同结论重复提交是幂等的（`replayed`）。
 */
export const LegacyMediaAuditDecisionInputSchema = z.strictObject({
  decision: LegacyMediaAuditDecisionSchema,
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative(),
})
export type LegacyMediaAuditDecisionInput = z.infer<typeof LegacyMediaAuditDecisionInputSchema>

export const LegacyMediaAuditDecisionResponseSchema = z.object({
  id: LegacyMediaAuditItemIdSchema,
  decision: LegacyMediaAuditDecisionSchema,
  /** 同结论重复提交时为 true：不重复写审计日志，也不再次改可见性。 */
  replayed: z.boolean(),
  /** 处理后的新版本（重放时是当前版本）。 */
  version: z.number().int().nonnegative(),
})
export type LegacyMediaAuditDecisionResponse = z.infer<
  typeof LegacyMediaAuditDecisionResponseSchema
>

export const LEGACY_MEDIA_AUDIT_ERROR_CODES = [
  'LEGACY_MEDIA_AUDIT_NOT_FOUND',
  'LEGACY_MEDIA_AUDIT_CONFLICT',
  'LEGACY_MEDIA_AUDIT_INVALID_CURSOR',
  'LEGACY_MEDIA_AUDIT_UNAVAILABLE',
  'VALIDATION_FAILED',
] as const
export type LegacyMediaAuditErrorCode = (typeof LEGACY_MEDIA_AUDIT_ERROR_CODES)[number]

export const LEGACY_MEDIA_AUDIT_ROUTES = {
  queue: '/admin/legacy-media/audit',
  detail: (itemId: string) => `/admin/legacy-media/audit/${itemId}`,
  decision: (itemId: string) => `/admin/legacy-media/audit/${itemId}/decision`,
  media: (itemId: string) => `/admin/legacy-media/audit/${itemId}/media`,
} as const
