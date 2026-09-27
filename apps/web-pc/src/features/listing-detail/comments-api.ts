import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import {
  CommentCreateInputSchema,
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
