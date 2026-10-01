/**
 * Comment Domain 路由常量。
 *
 * 这些是 **API 侧路径**（根级）。与 `listings/routes.ts` 同口径：前端 typed client 与
 * API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 本域的 zod schema / DTO 在同目录的 `schema.ts`（Issue #111 落地）：前端 typed client
 * 与 API router 共用本文件的路径常量，响应形状一律用 `schema.ts` 的 schema 收口。
 */
export const COMMENT_ROUTES = {
  /** `GET` 取某商品的留言列表（游标分页，顶层留言各带 `replies`）；`POST` 发一条顶层留言。 */
  ofListing: (listingId: string) => `/listings/${listingId}/comments`,
  /** `POST` 回复某条留言。 */
  repliesOf: (commentId: string) => `/comments/${commentId}/replies`,
  /**
   * `GET` 我发过的留言（#195）。
   *
   * **本人作用域**：作者由 session 决定，不接受 `authorId` 查询参数 —— 放开它等于把
   * 「谁在哪儿说了什么」变成可枚举的公开数据。响应内嵌商品卡片，端上不必逐条回查详情。
   */
  myComments: '/me/comments',
  /**
   * `DELETE` 删除某条留言（#195）：**只允许作者本人**。
   *
   * 与 `repliesOf` 同属 `/comments/:commentId` 这个资源，只是方法不同。
   * 删除是**物理删除**，且会级联删掉该条之下的回复（DB 外键 `parent_id ON DELETE CASCADE`）；
   * 响应回实际删除条数，端上据此正确减计数，而不是本地假设「只少一条」。
   */
  comment: (commentId: string) => `/comments/${commentId}`,
} as const
