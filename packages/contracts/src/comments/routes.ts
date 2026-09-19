/**
 * Comment Domain 路由常量。
 *
 * 这些是 **API 侧路径**（根级）。与 `listings/routes.ts` 同口径：前端 typed client 与
 * API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * **本域目前只有路由常量，没有 schema / DTO。** 后端能力（Contract + DB + API）尚未实现，
 * 缺口登记见 #89 §三 A5，专项 Issue 见 #111。zod schema 一旦落地，要连同
 * `packages/contracts/src/comments/schema.ts` 一起补 —— 在那之前调用方
 * **不得**按某个假想形状做 parse（见 `apps/miniapp/src/features/listing/comments.ts`）。
 */
export const COMMENT_ROUTES = {
  /** `GET` 取某商品的留言列表（游标分页，顶层留言各带 `replies`）；`POST` 发一条顶层留言。 */
  ofListing: (listingId: string) => `/listings/${listingId}/comments`,
  /** `POST` 回复某条留言。 */
  repliesOf: (commentId: string) => `/comments/${commentId}/replies`,
} as const
