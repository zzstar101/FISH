import type { MessageDto } from '@fish/contracts/chat/schema'
import { DISPUTE_ROUTES } from '@fish/contracts/disputes/routes'
import {
  type DisputeAttachmentConfirmRequest,
  DisputeAttachmentConfirmRequestSchema,
  type DisputeAttachmentConfirmResponse,
  DisputeAttachmentConfirmResponseSchema,
  type DisputeAttachmentPresignRequest,
  DisputeAttachmentPresignRequestSchema,
  type DisputeAttachmentPresignResponse,
  DisputeAttachmentPresignResponseSchema,
  type DisputeCreateInput,
  type DisputeCreateResponse,
  DisputeCreateResponseSchema,
  type DisputeDetail,
  DisputeDetailSchema,
  type DisputeEvidenceInput,
  DisputeEvidenceInputSchema,
  type DisputeEvidenceResponse,
  DisputeEvidenceResponseSchema,
  type DisputeListResponse,
  DisputeListResponseSchema,
} from '@fish/contracts/disputes/schema'
import { ALLOWED_IMAGE_MIME } from '@fish/contracts/listings/schema'
import { apiRequest } from '../../lib/api-client'
import { fetchMessagePage } from '../chat/api'
import { fetchTransaction } from '../profile/api'
import { imagePreparationMessage, toUploadableFile, validateImageFile } from '../publish/api'

/** 「我的争议」单页条数（契约 `DisputeMineQuerySchema.limit` 服务端封顶 50）。 */
export const DISPUTE_PAGE_LIMIT = 20

/** `GET /disputes/mine` 的请求路径（导出便于测试路径与游标拼装）。 */
export function myDisputesPath(cursor?: string, limit = DISPUTE_PAGE_LIMIT): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${DISPUTE_ROUTES.mine}?${params.toString()}`
}

export async function fetchMyDisputes(
  cursor?: string,
  limit = DISPUTE_PAGE_LIMIT,
): Promise<DisputeListResponse> {
  return DisputeListResponseSchema.parse(await apiRequest(myDisputesPath(cursor, limit)))
}

/** 详情：非当事人 / 不存在都是 404 `DISPUTE_NOT_FOUND`（服务端不泄漏存在性）。 */
export async function fetchDispute(disputeId: string): Promise<DisputeDetail> {
  return DisputeDetailSchema.parse(await apiRequest(DISPUTE_ROUTES.detail(disputeId)))
}

/**
 * 发起争议：`201` 新建 / `200` 复用同一交易同一方向的未决争议（`created: false`）。
 *
 * 两者都是**受理成功**（与举报同一契约姿态：超时重试对客户端无感）。调用方都直接进入
 * 详情页，`created` 只用于是否需要提示「已有进行中的争议」。
 */
export async function startDispute(input: DisputeCreateInput): Promise<DisputeCreateResponse> {
  const payload = await apiRequest(DISPUTE_ROUTES.create, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return DisputeCreateResponseSchema.parse(payload)
}

/** 撤回：服务端返回撤回后的完整详情（含时间线字段），调用方直接替换缓存。 */
export async function withdrawDispute(disputeId: string): Promise<DisputeDetail> {
  return DisputeDetailSchema.parse(
    await apiRequest(DISPUTE_ROUTES.withdraw(disputeId), { method: 'POST' }),
  )
}

/**
 * 上传一张附件：HEIC→JPG 预处理 → presign → PUT 对象存储 → confirm 写台账。
 *
 * 预处理与其它四处图片上传入口**同一个 helper**（`toUploadableFile` /
 * `imagePreparationMessage`）：浏览器能展示的格式原样上传，HEIC 先转 JPG，
 * 转不了时给「HEIC 图片转换失败」的可区分文案，不把注定 422 的文件送去上传。
 *
 * 三步里任何一步失败都抛给调用方，但**PUT 失败与 confirm 失败要可区分**：
 * - 预校验 / presign 失败：`ApiError` 或本地校验 Error（配额、格式、尺寸）；
 * - PUT 失败：对象没写进去，服务端台账无行，提示用户重试即可；
 * - confirm 失败：对象可能已写入 staging，服务端失败路径会尽力回滚对象；用户重试会重新
 *   presign 拿到新键（本函数不缓存 staging 键）。
 */
export async function uploadDisputeAttachment(disputeId: string, file: File): Promise<void> {
  const prepared = await toUploadableFile(file)
  if (prepared === null) throw new Error(imagePreparationMessage(file))
  const invalid = validateImageFile(prepared)
  if (invalid !== null) throw new Error(invalid)
  const contentType = (ALLOWED_IMAGE_MIME as readonly string[]).find(
    (mime) => mime === prepared.type,
  )
  if (contentType === undefined) throw new Error('仅支持 JPG / PNG / WebP 图片')

  const presignInput: DisputeAttachmentPresignRequest = DisputeAttachmentPresignRequestSchema.parse(
    {
      contentType,
      sizeBytes: prepared.size,
    },
  )
  const presign: DisputeAttachmentPresignResponse = DisputeAttachmentPresignResponseSchema.parse(
    await apiRequest(DISPUTE_ROUTES.attachmentPresign(disputeId), {
      method: 'POST',
      body: JSON.stringify(presignInput),
    }),
  )

  const uploaded = await fetch(presign.uploadUrl, {
    body: prepared,
    headers: { ...presign.headers, 'content-type': contentType },
    method: 'PUT',
  })
  if (!uploaded.ok) throw new Error('图片上传失败，请重试')

  const confirmInput: DisputeAttachmentConfirmRequest = DisputeAttachmentConfirmRequestSchema.parse(
    {
      objectKey: presign.objectKey,
    },
  )
  const confirmed: DisputeAttachmentConfirmResponse = DisputeAttachmentConfirmResponseSchema.parse(
    await apiRequest(DISPUTE_ROUTES.attachmentConfirm(disputeId), {
      method: 'POST',
      body: JSON.stringify(confirmInput),
    }),
  )
  // 幂等命中（同一张图重复确认）也视为成功：台账行已存在、详情刷新后就在列表里。
  void confirmed.created
}

/** 关联一条聊天消息作为证据（只提交 `msg_` 公开 ID，服务端校验消息归属）。 */
export async function addDisputeEvidence(
  disputeId: string,
  messageId: string,
): Promise<DisputeEvidenceResponse> {
  const input: DisputeEvidenceInput = DisputeEvidenceInputSchema.parse({ messageId })
  return DisputeEvidenceResponseSchema.parse(
    await apiRequest(DISPUTE_ROUTES.evidenceMessages(disputeId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/** 证据选择器需要的数据：交易会话 id + 该会话最新一页消息。 */
export type DisputeConversation = {
  conversationId: string
  messages: MessageDto[]
}

/**
 * 从争议读交易会话：争议摘要里**没有** `conversationId`（契约只给交易 id），
 * 所以先用 `GET /transactions/:id` 拿会话 id，再按会话读消息（口径同任务书）。
 *
 * 返回 `null` 表示交易已不可见（非当事人 / 已删）——端上按空态处理，不伪造消息。
 */
export async function fetchDisputeConversation(
  transactionId: string,
): Promise<DisputeConversation | null> {
  const transaction = await fetchTransaction(transactionId)
  if (transaction === null) return null
  const page = await fetchMessagePage(transaction.conversationId)
  return { conversationId: transaction.conversationId, messages: page.items }
}
