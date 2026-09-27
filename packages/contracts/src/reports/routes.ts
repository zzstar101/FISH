/**
 * Reports Domain 路由常量（#73 治理半场，用户端）。
 *
 * 这些是 **API 侧路径**（根级 `/reports`），口径与 listings / wishes 一致：**API 路径不含浏览器前缀**。
 * 管理端的举报路径（`/admin/reports`…）不在本文件——它们是 Admin Domain 的路径，按 moderation 的
 * 先例放在 `packages/contracts/src/admin/routes.ts` 的 `ADMIN_ROUTES` 里，保持「`/admin` 下所有
 * 路径只有一个来源」。前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 */
export const REPORT_ROUTES = {
  base: '/reports',
  /** POST 提交举报。重复举报同一目标返回已存在的那条（200），不新增。 */
  create: '/reports',
  /** GET 「我的举报」列表（游标分页，含处理状态）。 */
  mine: '/reports/mine',
} as const
