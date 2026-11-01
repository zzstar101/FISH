/**
 * 微信订阅消息路由常量（#462）。
 *
 * 口径与 `notifications` / `listings` 的 `routes.ts` 一致：**API 侧路径（根级）**，
 * 不含浏览器前缀。端上的 typed client 与 API router 共用本文件，禁止在别处硬编码。
 */
export const SUBSCRIBE_MESSAGE_ROUTES = {
  /**
   * GET 各 kind 的模板 ID（或 `null` = 未开通）。**不需要登录**：它对所有调用方返回同一份
   * 静态配置、不含任何用户数据，而端上要在登录前就决定"这台手机上有没有这个能力"。
   */
  config: '/subscribe-messages/config',
  /**
   * POST 上报 `wx.requestSubscribeMessage` 的结果（`requireAuth` + 写守卫），返回各 kind
   * 剩余次数。挂在 `/me` 下：它是本人记账的唯一读口，与 `/me/favorites` 同一挂法。
   */
  grants: '/me/subscribe-messages/grants',
} as const
