import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import type { MyCommentsKind, MyCommentsResponse } from '@fish/contracts/comments/schema'
import { MyCommentsResponseSchema } from '@fish/contracts/comments/schema'
import { apiRequest } from '../../lib/api-client'

/** 我的评论每页条数：契约默认 20、上限 50，端上取默认。 */
export const MY_COMMENTS_PAGE_LIMIT = 20

export function myCommentsPath(input: {
  limit: number
  kind: MyCommentsKind
  cursor?: string
}): string {
  const params = new URLSearchParams({ kind: input.kind, limit: String(input.limit) })
  if (input.cursor !== undefined) params.set('cursor', input.cursor)
  return `${COMMENT_ROUTES.myComments}?${params.toString()}`
}

/**
 * 我发过的留言/评价（#195 PR2 口径）。作者由服务端按登录态判定，端上无法指定别人；
 * `total` 与本次请求的 `kind` 同口径（分段计数用它，不旁路再发 count）。
 */
export async function fetchMyComments(input: {
  limit: number
  kind: MyCommentsKind
  cursor?: string
}): Promise<MyCommentsResponse> {
  return MyCommentsResponseSchema.parse(await apiRequest(myCommentsPath(input)))
}
