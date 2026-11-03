/**
 * 交易争议 API 适配器（#497）。
 *
 * 与举报（`features/reports/api.ts`）同一手法：路径只从 `@fish/contracts/disputes/routes`
 * 取，响应一律过 zod 校验，页面不各自拼 URL、也不各自摸错误信封。
 *
 * 上传链的 Taro 部分单独放在 `./upload.ts`：本模块保持可脱离平台单测（bun 里没有 Taro 运行时）。
 */
import { DISPUTE_ROUTES } from '@fish/contracts/disputes/routes'
import {
  DisputeAttachmentConfirmRequestSchema,
  type DisputeAttachmentConfirmResponse,
  DisputeAttachmentConfirmResponseSchema,
  type DisputeAttachmentPresignRequest,
  DisputeAttachmentPresignRequestSchema,
  type DisputeAttachmentPresignResponse,
  DisputeAttachmentPresignResponseSchema,
  type DisputeCreateInput,
  DisputeCreateInputSchema,
  type DisputeCreateResponse,
  DisputeCreateResponseSchema,
  type DisputeDetail,
  DisputeDetailSchema,
  DisputeEvidenceInputSchema,
  type DisputeEvidenceResponse,
  DisputeEvidenceResponseSchema,
  type DisputeListResponse,
  DisputeListResponseSchema,
} from '@fish/contracts/disputes/schema'
import { apiRequest } from '@/lib/request'

/** 与契约 `DisputeMineQuerySchema` 的默认值一致；列表页一屏一页。 */
export const DISPUTE_PAGE_SIZE = 20

/** 我发起的 + 我被诉的（服务端已按 `created_at DESC` 排好，cursor 向后翻）。 */
export async function fetchMyDisputePage(cursor?: string): Promise<DisputeListResponse> {
  const payload = await apiRequest(DISPUTE_ROUTES.mine, {
    query: { limit: DISPUTE_PAGE_SIZE, cursor },
  })
  return DisputeListResponseSchema.parse(payload)
}

/** 详情：非参与人在服务端一律 404（不泄漏存在性），页面按 `DISPUTE_NOT_FOUND` 走友好提示。 */
export async function fetchDisputeDetail(disputeId: string): Promise<DisputeDetail> {
  const payload = await apiRequest(DISPUTE_ROUTES.detail(disputeId))
  return DisputeDetailSchema.parse(payload)
}

/** 发起争议。同一交易同方向已有未决争议时服务端返回 200 + `created:false`（同一形状）。 */
export async function createDispute(input: DisputeCreateInput): Promise<DisputeCreateResponse> {
  const body = DisputeCreateInputSchema.parse(input)
  const payload = await apiRequest(DISPUTE_ROUTES.create, { method: 'POST', body })
  return DisputeCreateResponseSchema.parse(payload)
}

/** 撤回（仅发起人 + 仅 PENDING，服务端判定；终态返回 409 `DISPUTE_NOT_PENDING`）。 */
export async function withdrawDispute(disputeId: string): Promise<DisputeDetail> {
  const payload = await apiRequest(DISPUTE_ROUTES.withdraw(disputeId), { method: 'POST' })
  return DisputeDetailSchema.parse(payload)
}

/** 附件三步链第 1 步：拿一次性 PUT 地址（额度满 6 张时服务端 422 `DISPUTE_ATTACHMENT_LIMIT`）。 */
export async function presignDisputeAttachment(
  disputeId: string,
  input: DisputeAttachmentPresignRequest,
): Promise<DisputeAttachmentPresignResponse> {
  const body = DisputeAttachmentPresignRequestSchema.parse(input)
  const payload = await apiRequest(DISPUTE_ROUTES.attachmentPresign(disputeId), {
    method: 'POST',
    body,
  })
  return DisputeAttachmentPresignResponseSchema.parse(payload)
}

/** 附件三步链第 3 步：确认对象落库（幂等；返回既有行时 `created:false`）。 */
export async function confirmDisputeAttachment(
  disputeId: string,
  objectKey: string,
): Promise<DisputeAttachmentConfirmResponse> {
  const body = DisputeAttachmentConfirmRequestSchema.parse({ objectKey })
  const payload = await apiRequest(DISPUTE_ROUTES.attachmentConfirm(disputeId), {
    method: 'POST',
    body,
  })
  return DisputeAttachmentConfirmResponseSchema.parse(payload)
}

/** 关联一条聊天消息作为证据（重复关联幂等返回 `created:false`）。 */
export async function addDisputeEvidence(
  disputeId: string,
  messageId: string,
): Promise<DisputeEvidenceResponse> {
  const body = DisputeEvidenceInputSchema.parse({ messageId })
  const payload = await apiRequest(DISPUTE_ROUTES.evidenceMessages(disputeId), {
    method: 'POST',
    body,
  })
  return DisputeEvidenceResponseSchema.parse(payload)
}
