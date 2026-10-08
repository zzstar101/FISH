import { FEEDBACK_ROUTES } from '@fish/contracts/feedback/routes'
import {
  type FeedbackCreateRequest,
  type FeedbackCreateResponse,
  FeedbackCreateResponseSchema,
  type FeedbackListResponse,
  FeedbackListResponseSchema,
} from '@fish/contracts/feedback/schema'
import { apiRequest } from '../../lib/api-client'

/** 「我的反馈」单页条数（契约 `limit` 服务端封顶 50）。 */
export const FEEDBACK_PAGE_LIMIT = 20

/**
 * 提交反馈：`201` 新建 / `200` 同一 `clientRequestId` 的重放（`created: false`）。
 * 两者都算提交成功——超时重试带回同一个键，服务端只会有一条。
 */
export async function submitFeedback(
  input: FeedbackCreateRequest,
): Promise<FeedbackCreateResponse> {
  const payload = await apiRequest(FEEDBACK_ROUTES.create, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return FeedbackCreateResponseSchema.parse(payload)
}

export async function fetchMyFeedback(
  cursor?: string,
  limit = FEEDBACK_PAGE_LIMIT,
): Promise<FeedbackListResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor !== undefined) params.set('cursor', cursor)
  const payload = await apiRequest(`${FEEDBACK_ROUTES.mine}?${params.toString()}`)
  return FeedbackListResponseSchema.parse(payload)
}
