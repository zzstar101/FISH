import { z } from 'zod'
import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from '../listings/schema'
import {
  DisputeIdSchema,
  ListingIdSchema,
  MediaIdSchema,
  MessageIdSchema,
  TransactionIdSchema,
  UserIdSchema,
} from '../system/public-id'
import { transactionStatusSchema } from '../transactions/schema'

/**
 * Disputes Domain Contract（#465）。
 *
 * 交易争议：从**本人订单**发起、关联真实交易、带受限图片附件与聊天证据，由管理端处理
 * 并给出结论；用户能查询本人进度与结果。设计见 `.grill465/plan.md`（本单 grill 结论）。
 *
 * 与 `reports` 的关系：**两个域，不共用表**。举报处理的是"内容/账号违规"，争议处理的是
 * "这笔交易出了什么问题"。共享的只有"处理结果 + 原因 + 审计"这一形状，枚举、状态机、
 * 附件与证据关联都是争议独有的。举报的 `target_id` 是多态裸 uuid，没有外键兜底，
 * 而票面要求争议"关联真实交易"，所以这里用真外键 + 参与人校验。
 *
 * 边界（票面「不做」）：
 * - **结论不改变成交事实**：处理争议不修改 `transactions.status` / `listings.status`。
 * - **结论不执行处罚**：不封禁、不下架、不调用治理服务；封禁/下架是另外的端点。
 * - 不涉及平台支付、退款、资金托管或自动裁定责任。
 * - 本单**不做申诉**：结论不改成交事实、不执行处罚，用户损失面为零，独立申诉工单属需求外。
 *
 * 可见性：只有**发起人、被诉方、管理员**能看到一条争议；其他登录用户一律 404
 * （`DISPUTE_NOT_FOUND`，与 `TRANSACTION_NOT_FOUND` 同手法：不泄漏存在性）。
 * 列表只有「我的争议」（`GET /disputes/mine`），没有按交易枚举全部争议的公开端点。
 */

// ---------------------------------------------------------------------------
// 枚举（镜像 DB：packages/db/src/schema/disputes.ts）
// ---------------------------------------------------------------------------

/** 争议类型。刻意**不含**骚扰/威胁——那属于举报域，且争议结论不触发治理动作。 */
export const DisputeTypeSchema = z.enum([
  'ITEM_MISMATCH',
  'NOT_COMPLETED',
  'PAYMENT_ISSUE',
  'OTHER',
])
export type DisputeType = z.infer<typeof DisputeTypeSchema>

/** 争议状态机：`PENDING → RESOLVED`（管理员）/ `→ WITHDRAWN`（发起人）；后两者均为终态。 */
export const DisputeStatusSchema = z.enum(['PENDING', 'RESOLVED', 'WITHDRAWN'])
export type DisputeStatus = z.infer<typeof DisputeStatusSchema>

/** 处理结论。只描述"本次反馈是否成立"，不等同于处罚。 */
export const DisputeResolutionSchema = z.enum(['UPHELD', 'DISMISSED', 'INCONCLUSIVE'])
export type DisputeResolution = z.infer<typeof DisputeResolutionSchema>

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 一条争议最多 6 张附件图。 */
export const MAX_DISPUTE_ATTACHMENTS = 6

/** 补充说明上限（trim 后 1..1000）。与举报的 200 字分开：争议需要描述交易过程。 */
export const MAX_DISPUTE_DETAIL_LENGTH = 1000

/** 处理原因上限，与 `AdminReportHandleInputSchema.reason` 一致。 */
export const MAX_DISPUTE_RESOLUTION_NOTE_LENGTH = 500

/**
 * 终态后仍可发起争议的窗口（天）。`PENDING_MEETUP` 的交易没有时限；
 * 已成交 / 已取消的交易只在这个窗口内可发起，超窗返回 `DISPUTE_WINDOW_CLOSED`。
 */
export const DISPUTE_WINDOW_DAYS = 30

// ---------------------------------------------------------------------------
// 共享子结构
// ---------------------------------------------------------------------------

/** 与 `ReportUserSummarySchema` 同形：只暴露展示所需的最小字段。 */
export const DisputeUserSummarySchema = z.object({
  id: UserIdSchema,
  nickname: z.string(),
})
export type DisputeUserSummary = z.infer<typeof DisputeUserSummarySchema>

/**
 * 争议关联的交易摘要。**内联进 `DisputeSchema`**（列表也用同一形状），
 * 避免列表页对每行再查一次交易。
 */
export const DisputeTransactionSummarySchema = z.object({
  id: TransactionIdSchema,
  listingId: ListingIdSchema,
  listingTitle: z.string(),
  buyer: DisputeUserSummarySchema,
  seller: DisputeUserSummarySchema,
  amountCents: z.number().int().min(0),
  status: transactionStatusSchema,
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type DisputeTransactionSummary = z.infer<typeof DisputeTransactionSummarySchema>

/**
 * 受限图片附件。`id` 是 `med_` 公开 ID，也是对象键第三段（`dispute-media/{dsp_}/{usr_}/{med_}.{ext}`）。
 *
 * 存储与读取规则（票面「附件私有存储、授权读取与清理规则明确」）：
 * - 对象前缀 `dispute-media/` **不在** `infra/minio-public-policy.json` 的匿名白名单里，
 *   `listings/*` 之外没有匿名读，因此附件天然私有、不可列举、无公开直链；
 * - 授权读只有一条路径：`GET /uploads/dispute-media/:token`，token 是 AES-256-GCM 的
 *   `{key, exp, contentDigest}` capability URL，TTL 900 秒、不带会话鉴权（小程序原生
 *   `<Image>` 不发 cookie），响应 `Cache-Control: private, max-age=300` 且 `nosniff`；
 * - **只增不改不删**：附件行没有 UPDATE / DELETE 端点，`object_key` 唯一，
 *   `confirm` 对同一键幂等（重复确认返回既有行）。唯一键**不足以**保证字节不变 ——
 *   预签名 PUT 在有效期内仍可对同一 key 二次 PUT，所以 `confirm` 把确认时刻实读字节的
 *   sha256 写进 `content_digest`，读代理下发前重算比对，不一致即 404；
 * - **写入方只有发起人**（plan §3/§4 冻结）：被诉方能看全部材料与结论，但不能补材料 ——
 *   否则被诉方可以占用双方共享的 6 张额度；
 * - 对象写入的删除点只有 `confirm` 的失败回滚（校验失败或插行失败即删对象，不留无台账
 *   引用的孤儿字节；幂等命中既有行时不删）。另外 `presign` 会数一次
 *   `dispute-media/{dsp_}/{usr_}/` 前缀下的对象数，达到 6 就拒发上传地址 —— 所以
 *   「只 presign + PUT、从不 confirm」也写不进第 7 个对象：配额是**存储侧**的，
 *   不只数台账行。本单不新增后台 GC（仓库现有四个私有前缀同样没有 GC，唯一例外是
 *   `visual_query_images` 的到期清理），残留对象由运营侧按前缀清理。
 */
export const DisputeAttachmentSchema = z.object({
  id: MediaIdSchema,
  /** 授权读取 URL（短期签名 capability URL，见 `GET /uploads/dispute-media/:token`）。 */
  url: z.url(),
  mimeType: z.enum(ALLOWED_IMAGE_MIME),
  sizeBytes: z.number().int().min(1),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  uploadedBy: DisputeUserSummarySchema,
  createdAt: z.iso.datetime(),
})
export type DisputeAttachment = z.infer<typeof DisputeAttachmentSchema>

/**
 * 被关联的聊天证据（**单条消息，不是整段会话**）。
 *
 * 刻意**不含 `conversationId`**：争议只需要证明"这句话说过"，把会话 id 交给管理端
 * 就等于把整段私聊的口子开出来。正文读取权仍归 messages 域，这里只是投影。
 *
 * 只增不改不删：`dispute_evidence_messages` 没有 UPDATE / DELETE 端点，`(dispute_id, message_id)`
 * 唯一且重复关联幂等返回既有行。投影按 `message_id` 读 messages 域的行；该行本身不可变
 * （`messages` 无编辑端点），消息后来被撤回也只置 `recalled_at`，所以正文依旧稳定可读
 * （`recalledAt` 照实给出，读侧自行判断）——证据不可被覆盖替换。
 */
export const DisputeEvidenceMessageSchema = z.object({
  id: MessageIdSchema,
  type: z.enum(['TEXT', 'SYSTEM', 'MEDIA', 'LISTING']),
  /** `SYSTEM` 消息没有发送者（`messages.sender_id` 可空）。 */
  senderId: UserIdSchema.nullable(),
  senderNickname: z.string().nullable(),
  content: z.string(),
  recalledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type DisputeEvidenceMessage = z.infer<typeof DisputeEvidenceMessageSchema>

export const DisputeEvidenceSchema = z.object({
  message: DisputeEvidenceMessageSchema,
  addedBy: DisputeUserSummarySchema,
  createdAt: z.iso.datetime(),
})
export type DisputeEvidence = z.infer<typeof DisputeEvidenceSchema>

// ---------------------------------------------------------------------------
// 争议本体
// ---------------------------------------------------------------------------

/** 列表 / 详情共用的争议主体（不含附件与证据数组）。 */
export const DisputeSchema = z.object({
  id: DisputeIdSchema,
  type: DisputeTypeSchema,
  status: DisputeStatusSchema,
  detailText: z.string().nullable(),
  /** 发起人（当前查看者可能是其中任意一方）。 */
  initiator: DisputeUserSummarySchema,
  /** 被诉方 = 交易的另一方，由服务端从交易推导，请求体不可指定。 */
  respondent: DisputeUserSummarySchema,
  transaction: DisputeTransactionSummarySchema,
  resolution: DisputeResolutionSchema.nullable(),
  /** 结论文本；仅 `RESOLVED` 时非空。 */
  resolutionNote: z.string().nullable(),
  handledBy: DisputeUserSummarySchema.nullable(),
  handledAt: z.iso.datetime().nullable(),
  withdrawnAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Dispute = z.infer<typeof DisputeSchema>

/** 详情 = 主体 + 附件 + 证据。 */
export const DisputeDetailSchema = DisputeSchema.extend({
  attachments: z.array(DisputeAttachmentSchema),
  evidence: z.array(DisputeEvidenceSchema),
})
export type DisputeDetail = z.infer<typeof DisputeDetailSchema>

export const DisputeListResponseSchema = z.object({
  items: z.array(DisputeSchema),
  nextCursor: z.string().nullable(),
})
export type DisputeListResponse = z.infer<typeof DisputeListResponseSchema>

/**
 * 发起争议。**没有 `respondentId`**：被诉方由交易推导，客户端无从指定，
 * 因此"把争议指向一个不相干的用户"在协议层就是不可表达的。
 */
export const DisputeCreateInputSchema = z
  .strictObject({
    transactionId: TransactionIdSchema,
    type: DisputeTypeSchema,
    detailText: z.string().trim().min(1).max(MAX_DISPUTE_DETAIL_LENGTH).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'OTHER' && value.detailText === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['detailText'],
        message: '争议类型为「其他」时必须填写说明',
      })
    }
  })
export type DisputeCreateInput = z.infer<typeof DisputeCreateInputSchema>

/**
 * 重复提交同一方向同一交易时返回 **200 + `created: false`**（而不是 409）：
 * 与举报一致，超时重试对客户端无感。
 */
export const DisputeCreateResponseSchema = z.object({
  dispute: DisputeDetailSchema,
  created: z.boolean(),
})
export type DisputeCreateResponse = z.infer<typeof DisputeCreateResponseSchema>

export const DisputeMineQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type DisputeMineQuery = z.infer<typeof DisputeMineQuerySchema>

/** 附件 presign 入参：与 `UploadPresignRequestSchema` 同形（mime 白名单 + 5MB 上限）。 */
export const DisputeAttachmentPresignRequestSchema = z.strictObject({
  contentType: z.enum(ALLOWED_IMAGE_MIME),
  sizeBytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
})
export type DisputeAttachmentPresignRequest = z.infer<typeof DisputeAttachmentPresignRequestSchema>

export const DisputeAttachmentPresignResponseSchema = z.object({
  uploadUrl: z.url(),
  /** 服务端生成的 staging 键（`dispute-media/{dsp_…}/{usr_…}/{med_…}.{ext}`）。 */
  objectKey: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
})
export type DisputeAttachmentPresignResponse = z.infer<
  typeof DisputeAttachmentPresignResponseSchema
>

/** 确认附件：与 `/uploads/confirm` 同形，body 只带 objectKey。 */
export const DisputeAttachmentConfirmRequestSchema = z.strictObject({
  objectKey: z.string().min(1),
})
export type DisputeAttachmentConfirmRequest = z.infer<typeof DisputeAttachmentConfirmRequestSchema>

export const DisputeAttachmentConfirmResponseSchema = z.object({
  attachment: DisputeAttachmentSchema,
  /** 重复确认同一张图时 `false`（幂等，不产生第二行）。 */
  created: z.boolean(),
})
export type DisputeAttachmentConfirmResponse = z.infer<
  typeof DisputeAttachmentConfirmResponseSchema
>

/** 关联聊天证据：只接受 `msg_` 公开 ID，服务端校验它属于本交易的会话。 */
export const DisputeEvidenceInputSchema = z.strictObject({ messageId: MessageIdSchema })
export type DisputeEvidenceInput = z.infer<typeof DisputeEvidenceInputSchema>

export const DisputeEvidenceResponseSchema = z.object({
  evidence: DisputeEvidenceSchema,
  created: z.boolean(),
})
export type DisputeEvidenceResponse = z.infer<typeof DisputeEvidenceResponseSchema>

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const AdminDisputeQueueQuerySchema = z.strictObject({
  status: DisputeStatusSchema.optional(),
  type: DisputeTypeSchema.optional(),
  /** 关键词：说明 / 商品标题 / 双方昵称。 */
  q: z.string().trim().min(1).max(50).optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type AdminDisputeQueueQuery = z.infer<typeof AdminDisputeQueueQuerySchema>

/** 队列行 = 争议主体 + 处理人 + 计数（不内联附件与证据，详情才有）。 */
export const AdminDisputeItemSchema = z.object({
  dispute: DisputeSchema.safeExtend({ handledBy: DisputeUserSummarySchema.nullable() }),
  attachmentCount: z.number().int().min(0),
  evidenceCount: z.number().int().min(0),
  /** 同一交易上的争议总数（含其他方向 / 历史），用来判断是否重复纠缠。 */
  disputeCount: z.number().int().min(0),
})
export type AdminDisputeItem = z.infer<typeof AdminDisputeItemSchema>

export const AdminDisputeListResponseSchema = z.object({
  items: z.array(AdminDisputeItemSchema),
  nextCursor: z.string().nullable(),
})
export type AdminDisputeListResponse = z.infer<typeof AdminDisputeListResponseSchema>

export const AdminDisputeDetailSchema = z.object({
  item: AdminDisputeItemSchema,
  attachments: z.array(DisputeAttachmentSchema),
  evidence: z.array(DisputeEvidenceSchema),
  /**
   * 同一交易上的其他**未决**争议（含反方向），只给主体、不含附件，封顶 20 条。
   *
   * 已处理的同交易争议不进这里（与举报的 `listRelatedPending` 同一口径）；同交易争议
   * 总数看 `item.disputeCount`，那个是全量计数，不受这里的 20 条上限影响。
   */
  related: z.array(DisputeSchema),
})
export type AdminDisputeDetail = z.infer<typeof AdminDisputeDetailSchema>

/** 处理争议：只写结论与原因，**不触发治理动作**。 */
export const AdminDisputeResolveInputSchema = z.strictObject({
  resolution: DisputeResolutionSchema,
  reason: z.string().trim().min(1).max(MAX_DISPUTE_RESOLUTION_NOTE_LENGTH),
})
export type AdminDisputeResolveInput = z.infer<typeof AdminDisputeResolveInputSchema>

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

export const DisputeErrorCodeSchema = z.enum([
  /** 404：交易不存在，或调用者不是该交易的买卖双方（不泄漏存在性）。 */
  'DISPUTE_TRANSACTION_NOT_FOUND',
  /** 404：争议不存在，或调用者既不是发起人也不是被诉方（不泄漏存在性）。 */
  'DISPUTE_NOT_FOUND',
  /** 404：消息不存在，或不属于本交易的会话（不泄漏存在性）。 */
  'DISPUTE_MESSAGE_NOT_FOUND',
  /** 409：并发处理——争议已被处理 / 撤回（先到先得）。 */
  'DISPUTE_CONFLICT',
  /** 409：交易已进终态且超出 30 天发起窗口。 */
  'DISPUTE_WINDOW_CLOSED',
  /** 422：附件数量已达上限。 */
  'DISPUTE_ATTACHMENT_LIMIT',
  /** 422：附件对象缺失 / 类型不符 / 尺寸不符 / 归属不符。 */
  'DISPUTE_ATTACHMENT_INVALID',
  /** 409：终态争议不可撤回（已处理或已撤回）。 */
  'DISPUTE_NOT_PENDING',
])
export type DisputeErrorCode = z.infer<typeof DisputeErrorCodeSchema>
