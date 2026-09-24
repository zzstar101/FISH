/**
 * Profile Domain 路由常量（Issue #12）。
 *
 * API 侧路径（根级）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉前缀；
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * P0 只有「我自己的聚合视图」一个端点：个人中心的数据都是本人视角，
 * 他人主页（P1 信用/浏览记录）不在本 Issue 范围。
 */
export const PROFILE_ROUTES = {
  /**
   * GET 当前登录用户的聚合视图（user + stats + listings/wishes/transactions 列表）。
   * #86 B：`PATCH` 同一个路径即「编辑资料」（昵称 / 头像），读写共用一个资源路径，
   * 因此这里不再单开常量。
   */
  me: '/profile',
} as const
