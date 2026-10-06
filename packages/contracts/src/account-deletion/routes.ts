/**
 * Account Deletion Domain 路由常量（Issue #464）。
 *
 * 这些是 **API 侧路径**（根级），前端 typed client 与 API router 共用本文件，
 * 禁止在别处硬编码这些路径。
 *
 * 三条方法（GET 读状态 / POST 申请 / DELETE 撤回）落在**同一个 URL** 上，
 * 与 `favorites/routes.ts` 的 `favoriteRelation` 同一形状：资源是「我的注销申请」这一条
 * 状态，它没有独立 id，端上也不必自己记 id。写接口都回完整状态而不是 204 —— 申请与撤回
 * 都幂等，端上以服务端返回的状态为准，不本地翻转再自己猜。
 *
 * 整挂 `requireAuth`（未登录 401 `UNAUTHENTICATED`）。注销态**不进** `Me` DTO（#3 契约保持
 * 冻结），需要知道自己在注销中的客户端打这里的 GET。
 */
export const ACCOUNT_DELETION_ROUTES = {
  /**
   * `GET` 当前注销状态、`POST` 申请注销、`DELETE` 撤回申请。
   *
   * - `GET`：任何登录态可读，包括冷静期内（这是冷静期内「还能做什么」的唯一自报入口）。
   * - `POST`：body 见 `RequestAccountDeletionSchema`（固定词二次确认）。幂等——已在冷静期内
   *   再次 POST 回 200 与既有状态，**不重置 7 天计时**。
   * - `DELETE`：幂等——不在冷静期时回 200 与当前状态。
   */
  status: '/me/account-deletion',
} as const
