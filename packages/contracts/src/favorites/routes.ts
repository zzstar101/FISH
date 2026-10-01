/**
 * Favorite Domain 路由常量（Issue #190）。
 *
 * 这些是 **API 侧路径**（根级），与 `users/routes.ts` 同口径：
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 两条路径都**没有匿名分支**：收藏是「我」与某件商品之间的关系，
 * 浏览者是谁决定了看得到哪一份数据，所以整挂 `requireAuth`（未登录 401 `UNAUTHENTICATED`）。
 *
 * 写操作刻意**不拆成 `POST /favorites` + `DELETE /favorites/:id`**：资源是
 * 「(我, 商品) 这条边」，商品 Public ID 就是它的地址，三条方法（GET 读状态 / POST 收藏 /
 * DELETE 取消）落在同一个 URL 上，端上不必自己记住收藏行的 id。
 */
export const FAVORITE_ROUTES = {
  /**
   * GET 我收藏的商品（`favorites.created_at DESC, listings.id DESC`，不透明游标分页）。
   *
   * 响应 `{ items, nextCursor, total }`：`total` 是**全量**计数（不是这一页），
   * 与 `/profile` 的 `stats.favoriteCount` 同表同向 —— 两个数字不能各算各的。
   */
  myFavorites: '/me/favorites',
  /**
   * 某件商品的收藏关系：GET 读状态、POST 收藏、DELETE 取消，三条是同一个资源路径。
   *
   * POST / DELETE 幂等（重复收藏 / 重复取消都回 200，不改写首次收藏时间），
   * 且都回 `{ favorited }` 而不是 204 —— 端上直接采用服务端结论，不本地翻转再自己猜。
   */
  favoriteRelation: (listingId: string) => `/listings/${listingId}/favorite`,
} as const
