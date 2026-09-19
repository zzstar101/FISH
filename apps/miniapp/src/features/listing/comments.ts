/**
 * 商品详情留言的**写**请求层。
 *
 * ## 后端不存在，这里只做「将来会调」的那一层
 *
 * 契约里没有 comments 域（`packages/contracts/src` 无 schema，只有 `comments/routes.ts`
 * 的路径常量），API 与 DB 也都没有 —— 缺口登记在 #89 §三 A5，专项 Issue 见 #111。
 * 所以本模块**只有两个写接口**，且**不消费返回值**：调用方（详情页）要的是
 * 「请求发出去了没有」，不是服务端回执。等后端落地，这里再补 `GET` 列表与 zod schema 收口。
 *
 * 为什么不先写一个没人调的 `fetchComments`：详情页的留言来自 `loadListingDetail`，
 * 本次改动没有第二处读路径，留一个不被调用的函数就是死代码（AGENTS.md §4）。
 *
 * ## 失败口径：fail closed，不退 mock
 *
 * 与 `features/fetchers.ts` 同口径：接口失败（含后端未实现时的 404）**原样抛出**，
 * 不返回任何 fixture。调用方据此把本地乐观插入的那条留在本地，而不是假装服务端收到了。
 */
import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import { apiRequest } from '@/lib/request'

/** 发一条顶层留言。失败时抛 `ApiError`（后端未实现时为 404）。 */
export async function postComment(listingId: string, content: string): Promise<void> {
  await apiRequest(COMMENT_ROUTES.ofListing(listingId), { method: 'POST', body: { content } })
}

/** 回复某条留言。失败时抛 `ApiError`（后端未实现时为 404）。 */
export async function postReply(commentId: string, content: string): Promise<void> {
  await apiRequest(COMMENT_ROUTES.repliesOf(commentId), { method: 'POST', body: { content } })
}
