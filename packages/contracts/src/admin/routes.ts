/**
 * Admin Domain 路由常量（Issue #73）。
 *
 * 这些是 **API 侧路径**（根级 `/admin`）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉
 * 前缀（`apps/web/vite.config.ts`、`docs/architecture.md` §5.1）；生产同源部署行为一致。
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 挂载：`apps/api/src/app.ts` 只把本 router 挂到 `/admin`（`app.route`），认证与授权两道守卫都在
 * `apps/api/src/modules/admin/router.ts` 内用 `router.use('*')` 应用（先 `requireAuth` 401，
 * 再 `requireAdmin` 403）——这样新增端点不会漏挂。口径与 listings / wishes 等域一致：
 * **API 路径不含浏览器前缀**。
 */
export const ADMIN_ROUTES = {
  base: '/admin',
  /** GET 当前管理员公开资料 + 角色 + 可选能力列表。非 Admin 一律 403，不能用来探测后台数据。 */
  me: '/admin/me',
  /** GET 用户查询（游标分页）。 */
  users: '/admin/users',
  /** GET 用户详情（概要 + 商品统计 + 最近 Admin 操作记录）。 */
  userDetail: (userId: string) => `/admin/users/${userId}`,
  /** GET 商品查询（游标分页）。 */
  listings: '/admin/listings',
  /** GET 商品详情（商品 + 卖家摘要 + 图片 + 关联操作日志）。 */
  listingDetail: (listingId: string) => `/admin/listings/${listingId}`,
  /** GET 平台概览：固定口径聚合指标。 */
  overview: '/admin/overview',
  /** GET 审计日志（只读，默认最新优先）。 */
  auditLogs: '/admin/audit-logs',
  /** GET 待人工审核队列。 */
  moderationQueue: '/admin/moderation/queue',
  /** GET 审核记录详情（含机器结果、历史和人工决定）。 */
  moderationDetail: (recordId: string) => `/admin/moderation/${recordId}`,
  /** POST 人工审核决定；Idempotency-Key 由 HTTP header 提供。 */
  moderationDecision: (recordId: string) => `/admin/moderation/${recordId}/decision`,
  /** GET 全量交易查询（仅管理员）。 */
  transactions: '/admin/transactions',
  /** GET 举报队列（游标分页 + 状态 / 目标类型 / 原因筛选）。 */
  reports: '/admin/reports',
  /** GET 举报详情（举报 + 举报人 + 目标摘要 + 同目标其它未决举报）。 */
  reportDetail: (reportId: string) => `/admin/reports/${reportId}`,
  /** POST 处理举报（result = HANDLED / REJECTED + reason）。只写处理结果，不触发治理动作。 */
  reportHandle: (reportId: string) => `/admin/reports/${reportId}/handle`,
  /**
   * 治理动作（#73 治理半场 PR3）。五个端点各自独立、可选带 `sourceReportId` 回链举报单；
   * 业务变更与审计写入同事务，并发靠条件更新（先到者成功，后到者 409）。
   */
  /** POST 下架商品（`prior_listing_status` 记进审计快照，供 restore 还原）。 */
  listingDelist: (listingId: string) => `/admin/listings/${listingId}/delist`,
  /** POST 恢复商品（目标状态取 delist 审计快照里的 prior_listing_status）。 */
  listingRestore: (listingId: string) => `/admin/listings/${listingId}/restore`,
  /** POST 限制用户发布（`PUBLISH_RESTRICT`）。 */
  userRestrictPublish: (userId: string) => `/admin/users/${userId}/restrict-publish`,
  /** POST 封禁用户（`BAN`，当前只禁写不禁读）。 */
  userBan: (userId: string) => `/admin/users/${userId}/ban`,
  /** POST 解除该用户**全部**生效中的限制（`PUBLISH_RESTRICT` 与 `BAN` 一起解）。 */
  userLiftRestriction: (userId: string) => `/admin/users/${userId}/lift-restriction`,
} as const
