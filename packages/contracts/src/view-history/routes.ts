/**
 * View History Domain 路由常量（Issue #415 M1）。
 *
 * 这些是 **API 侧路径**（根级），与 `favorites/routes.ts` / `follows/routes.ts` 同口径：
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 本域**没有匿名分支**：浏览记录是「我」看过的商品，浏览者是谁决定了看得到哪一份数据，
 * 所以整挂 `requireAuth`（未登录 401 `UNAUTHENTICATED`）。
 *
 * 只有一条路径、两个方法（GET 读列表 / DELETE 清空），因为端上冻结的动作只有「清空」
 * （Owner 2026-09-23 拍板三档统一用「清空」），没有单条删除的入口 —— 资源是「我的整份
 * 浏览记录」，不是逐条关系（与 `favorites` 的 `(我, 商品)` 边不同）。
 */
export const VIEW_HISTORY_ROUTES = {
  /**
   * GET 我的浏览记录（`listing_view_history.last_viewed_at DESC, listings.id DESC`，
   * 不透明游标分页）；DELETE 清空本人浏览记录（幂等，回 `{ deleted }`）。
   *
   * 响应 `{ items, nextCursor, total }`：`total` 是**全量**计数（不是这一页），
   * 与列表同一张表、同一个 30 天窗口 —— 数字栏与列表不能各算各的。
   */
  myViewHistory: '/me/view-history',
} as const
