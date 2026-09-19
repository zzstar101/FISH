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
} as const
