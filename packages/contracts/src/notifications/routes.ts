/**
 * Notification Domain 路由常量（Issue #23）。
 *
 * 这些是 **API 侧路径**（根级）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉前缀
 * （`apps/web/vite.config.ts`、`docs/architecture.md` §5.1）。口径与 `listings` / `wishes` /
 * `matches` 的 `routes.ts` 一致：**API 路径不含浏览器前缀**。前端 typed client 与 API router
 * 共用本文件，禁止在别处硬编码这些路径。
 *
 * 三个端点对应 #23 的三条读/写路径：列表、未读数、标记单条已读。
 */
export const NOTIFICATION_ROUTES = {
  /** GET 本人的通知列表（`created_at DESC, id DESC`，`limit` 默认 20 / 上限 50）。 */
  base: '/notifications',
  /**
   * GET 未读数 `{ unreadCount }`。
   *
   * 必须是**单独端点**：角标只要一个数字，为它拉整页通知既浪费流量也让「角标与列表不同步」
   * 成为可能。与列表响应里的任何字段都不共用。
   */
  unreadCount: '/notifications/unread-count',
  /** POST 标记单条已读（幂等：已读再点仍是 200，且不改写首次已读时间）。 */
  markRead: (id: string) => `/notifications/${id}/read`,
} as const
