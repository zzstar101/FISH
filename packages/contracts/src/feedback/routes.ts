/**
 * Feedback Domain 路由常量（#463，用户端）。
 *
 * API 侧路径（根级 `/feedback`），口径与 reports / disputes 一致：不含浏览器前缀。
 * 管理端路径（`/admin/feedback`…）按先例放在 `packages/contracts/src/admin/routes.ts` 的
 * `ADMIN_ROUTES` 里，保持「`/admin` 下所有路径只有一个来源」。
 */
export const FEEDBACK_ROUTES = {
  base: '/feedback',
  /** POST 提交反馈。同一 `clientRequestId` 重试返回已存在的那条（200），不新增。 */
  create: '/feedback',
  /** GET 「我的反馈」（游标分页，含处理状态与对我可见的回复）。 */
  mine: '/feedback/mine',
} as const
