import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import {
  CommentCreateInputSchema,
  type CommentDeleteResponse,
  CommentDeleteResponseSchema,
  type CommentDto,
  CommentDtoSchema,
  type CommentListResponse,
  CommentListResponseSchema,
  type CommentReply,
  CommentReplySchema,
} from '@fish/contracts/comments/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

/** 契约里留言列表 limit 上限 50。 */
export const COMMENT_PAGE_LIMIT = 50

export function commentListPath(listingId: string, cursor?: string): string {
  const params = new URLSearchParams()
  params.set('limit', String(COMMENT_PAGE_LIMIT))
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${COMMENT_ROUTES.ofListing(listingId)}?${params.toString()}`
}

/** 一页留言；cursor 是服务端下发的不透明串，前端只原样回传。 */
export async function fetchCommentPage(
  listingId: string,
  cursor?: string,
): Promise<CommentListResponse> {
  return CommentListResponseSchema.parse(await apiRequest(commentListPath(listingId, cursor)))
}

/** 发一条顶层留言，返回服务端写入的 DTO（含服务端判定的 isSeller）。 */
export async function createComment(listingId: string, content: string): Promise<CommentDto> {
  const input = CommentCreateInputSchema.parse({ content })
  return CommentDtoSchema.parse(
    await apiRequest(COMMENT_ROUTES.ofListing(listingId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/** 回复一条顶层留言；服务端会拒绝回复一条回复，响应固定是单层 CommentReply。 */
export async function createReply(commentId: string, content: string): Promise<CommentReply> {
  const input = CommentCreateInputSchema.parse({ content })
  return CommentReplySchema.parse(
    await apiRequest(COMMENT_ROUTES.repliesOf(commentId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/**
 * 删除自己的一条留言；删顶层留言会**级联带走它下面的回复**（不论回复是谁写的）。
 *
 * `deleted` 是「本次实际删掉的 DB 行数」——**不要**拿它去减「我发过的留言」计数：
 * 别人的回复被级联删掉时它会大于本人减少的条数（契约 `CommentDeleteResponseSchema` 写明）。
 *
 * 失败与幂等的分工（照抄服务端 `deleteMine`）：
 * - 不存在 / 已被自己删过 → 200 `{ deleted: 0 }`，**幂等成功**，不是错误；
 * - 存在但不是本人的 → 404 `COMMENT_NOT_FOUND`，**只表示这一件事**。
 */
export async function deleteComment(commentId: string): Promise<CommentDeleteResponse> {
  return CommentDeleteResponseSchema.parse(
    await apiRequest(COMMENT_ROUTES.comment(commentId), { method: 'DELETE' }),
  )
}

/** 留言写失败的展示文案：不把未知错误伪装成成功。 */
export function describeCommentFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'COMMENT_CONTENT_BLOCKED') return '留言内容未通过审核，请修改后重试'
    if (error.code === 'COMMENT_NOT_FOUND') return '留言不存在或已失效'
    if (error.code === 'LISTING_NOT_FOUND') return '商品不存在或已下架'
    if (error.code === 'VALIDATION_FAILED') return '留言内容不合法'
  }
  return '提交失败，请重试'
}

/**
 * 删除失败的展示文案：**用服务端原文**（与商品删除 #421 同一取向），未知错误不伪装成成功。
 *
 * 404 `COMMENT_NOT_FOUND` 的语义就是「存在但不是本人的」—— 服务端**不做**存在性混淆：
 * 留言 id 本就能由匿名接口枚举，混淆没有收益，所以 404 与「不存在」**不同码**
 * （不存在走的是 200 `{ deleted: 0 }`，见 `apps/api/src/modules/comments/service.ts` 的 `deleteMine`）。
 * 同理端上也不需要另编一句更含蓄的话。
 */
export function describeCommentDeleteFailure(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '删除失败，请重试'
}
