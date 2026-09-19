/**
 * 商品详情留言的请求层。
 *
 * 后端能力由 Issue #111 落地：契约 `@fish/contracts/comments/schema`，API
 * `apps/api/src/modules/comments`。本模块是**唯一**的留言传输入口（路径常量取自
 * `@fish/contracts/comments/routes`，禁止硬编码），响应一律用契约 schema 收口 ——
 * 形状漂移在解析处就炸，而不是渲染到页面上才炸。
 *
 * ## 失败口径：fail closed，不退 mock
 *
 * 与 `features/fetchers.ts` 同口径：接口失败**原样抛出**，不返回任何 fixture。
 * 写操作失败时调用方把本地乐观插入的那条留在本地，而不是假装服务端收到了。
 */
import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import {
  type CommentDto,
  CommentDtoSchema,
  type CommentListResponse,
  CommentListResponseSchema,
} from '@fish/contracts/comments/schema'
import { apiRequest } from '@/lib/request'

/** 留言列表单页上限：契约 `CommentListQuerySchema` 的 `limit` 上限是 50。 */
const PAGE_SIZE = 50

/**
 * 取某商品的留言列表（顶层留言各带 `replies`，只嵌套一层）。
 *
 * `cursor` 是不透明串，只能原样回传上一页的 `nextCursor`（契约禁止前端解析）。
 * 响应过 `CommentListResponseSchema`：zod schema 一旦漂移，这里立刻抛而不是把
 * 半个对象渲染上屏。
 */
export async function fetchComments(
  listingId: string,
  cursor?: string,
): Promise<CommentListResponse> {
  const payload = await apiRequest(COMMENT_ROUTES.ofListing(listingId), {
    query: { limit: PAGE_SIZE, cursor },
  })
  return CommentListResponseSchema.parse(payload)
}

/** 发一条顶层留言，返回服务端写入的留言（含服务端判定的 `isSeller`）。 */
export async function postComment(listingId: string, content: string): Promise<CommentDto> {
  const payload = await apiRequest(COMMENT_ROUTES.ofListing(listingId), {
    method: 'POST',
    body: { content },
  })
  return CommentDtoSchema.parse(payload)
}

/** 回复某条留言，返回服务端写入的回复。 */
export async function postReply(commentId: string, content: string): Promise<CommentDto> {
  const payload = await apiRequest(COMMENT_ROUTES.repliesOf(commentId), {
    method: 'POST',
    body: { content },
  })
  return CommentDtoSchema.parse(payload)
}
