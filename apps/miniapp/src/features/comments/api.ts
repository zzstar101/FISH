/**
 * 「我的评论」读删 API（#195 PR1/PR2 落地的端点，契约见 `@fish/contracts/comments`）。
 *
 * - `GET /me/comments`：**本人作用域**聚合（作者由 session 决定），`kind` 三档
 *   （`all` = 留言 ∪ 评价跨表合并 / `comment` 只留言 / `review` 只评价）。
 *   响应的 `total` 是**同 kind 口径的全量数**（服务端 COUNT，不是这一页长度），
 *   分段胶囊的计数只能用它，旁路自己数会把「这一页」当成「全部」。
 * - `DELETE /comments/:id`：只删**本人写的留言**，幂等；响应 `{ deleted }` 是实际删除行数
 *   （含被级联的**他人**回复），**不得**拿它减本人总数 —— 本人总数一律以重拉的 `total` 为准
 *   （契约 `CommentDeleteResponseSchema` 的警告）。
 *
 * 约定与 `features/favorites/api.ts` 一致：路径取契约常量，响应用 zod schema 收口。
 */
import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import {
  CommentDeleteResponseSchema,
  type MyCommentsKind,
  type MyCommentsResponse,
  MyCommentsResponseSchema,
} from '@fish/contracts/comments/schema'
import { apiRequest } from '@/lib/request'

/** 一页的条数。契约上限 50，取与收藏页相同的默认档 20。 */
export const MY_COMMENTS_PAGE_SIZE = 20

/** 拉一页「我发过的」。`cursor` 是不透明串，只能原样回传上一页的 `nextCursor`。 */
export async function fetchMyComments(args: {
  kind?: MyCommentsKind
  cursor?: string
  limit?: number
}): Promise<MyCommentsResponse> {
  const payload = await apiRequest(COMMENT_ROUTES.myComments, {
    query: {
      kind: args.kind,
      cursor: args.cursor,
      limit: args.limit ?? MY_COMMENTS_PAGE_SIZE,
    },
  })
  return MyCommentsResponseSchema.parse(payload)
}

/** 删除一条本人留言。返回本次实际删除行数（幂等：重复删回 0，不是错误）。 */
export async function deleteMyComment(commentId: string): Promise<number> {
  const payload = await apiRequest(COMMENT_ROUTES.comment(commentId), { method: 'DELETE' })
  return CommentDeleteResponseSchema.parse(payload).deleted
}
