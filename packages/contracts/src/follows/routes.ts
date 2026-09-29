/**
 * Follow Domain 路由常量（Issue #188）。
 *
 * 这些是 **API 侧路径**（根级），与 `users/routes.ts` / `notifications/routes.ts` 同口径：
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 三个路径分两类：
 * - `myFollowing`：本人数据，未登录 401 `UNAUTHENTICATED`；
 * - `followRelation`：他人主页上的关注状态与写入口，同样要求登录（匿名访客没有关注关系），
 *   未登录 401，目标不存在 404 `USER_NOT_FOUND`，自关注 422 `CANNOT_FOLLOW_SELF`。
 *
 * **读公开、写必须登录**在这里不适用：关注关系是「我」与某个人的有向边，两条都不公开
 * ——`GET /users/:userId/public`（#122）保持匿名可读且**不带**任何视角相关字段，
 * 关注状态单独放本域，避免把「看的人是谁」塞进公开读模型。
 */
export const FOLLOW_ROUTES = {
  /**
   * GET 我关注的人（`follows.created_at DESC, users.id DESC`，不透明游标分页）。
   *
   * 响应 `{ items, nextCursor, total, mutualTotal }`：`total` / `mutualTotal` 是**全量**计数
   * （不是这一页），页面顶部的「关注 N 人 · 互粉 M 人」直接取它 —— 分页列表拿不出全量计数，
   * 旁路再发一个 count 请求又会让两个数字有机会不一致。
   */
  myFollowing: '/me/following',
  /**
   * 某个人的关注关系：GET 读状态、POST 关注、DELETE 取关，三条是同一个资源路径。
   *
   * GET 回 `{ following, mutual }`（本人视角）；POST / DELETE 幂等（重复关注 / 重复取关
   * 都是 200，不改写首次建立时间）。`mutual` 一律由服务端按反向关系算。
   */
  followRelation: (userId: string) => `/users/${userId}/follow`,
} as const
