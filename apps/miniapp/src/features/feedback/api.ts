/**
 * 意见反馈域的接口调用（#463）：提交与「我的反馈」分页列表。
 *
 * 契约是唯一来源：路由常量与 zod schema 都从 `@fish/contracts/feedback/*` 取，
 * 响应必须过 schema 解析再交给页面 —— 后端多/少字段时在边界上就炸，而不是渲染出半张卡片。
 *
 * 与 `features/reports/api.ts` 同一形状：`apiRequest` 负责会话 cookie、超时与错误包 →
 * `ApiError`（页面据 `code` 给文案，见 `./meta`）。
 */
import { FEEDBACK_ROUTES } from '@fish/contracts/feedback/routes'
import {
  type FeedbackCreateInput,
  FeedbackCreateInputSchema,
  type FeedbackCreateResponse,
  FeedbackCreateResponseSchema,
  type FeedbackListResponse,
  FeedbackListResponseSchema,
} from '@fish/contracts/feedback/schema'
import { apiRequest } from '@/lib/request'

/** 与契约 `FeedbackMineQuerySchema` 的上限一致（1..50） */
const PAGE_SIZE = 20

/**
 * 提交一条反馈。
 *
 * `input` 先在本端过一遍 `FeedbackCreateInputSchema`：入口表单只做「必填 / 长度」的轻校验，
 * 契约才是权威（例如 `clientRequestId` 必须是 uuid、`contact` 空串要落成 `undefined`）。
 * 本端就非法时直接抛 zod 错误，不会发出一个必然 422 的请求。
 */
export async function submitFeedback(input: FeedbackCreateInput): Promise<FeedbackCreateResponse> {
  const body = FeedbackCreateInputSchema.parse(input)
  return FeedbackCreateResponseSchema.parse(
    await apiRequest(FEEDBACK_ROUTES.create, { method: 'POST', body }),
  )
}

/** 「我的反馈」一页（最新在前，游标分页） */
export async function fetchMyFeedbackPage(cursor?: string): Promise<FeedbackListResponse> {
  return FeedbackListResponseSchema.parse(
    await apiRequest(FEEDBACK_ROUTES.mine, {
      query: { limit: PAGE_SIZE, cursor },
    }),
  )
}
