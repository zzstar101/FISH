/**
 * Transaction Domain 路由常量（Issue #11）。
 *
 * 这些是 **API 侧路径**（根级）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉前缀；
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 「接受并创建交易」放在集合资源上（`POST /transactions`），与提案/拒绝分离：
 * 后两者只是往会话写 SYSTEM 消息，只有接受产生 transactions 行。
 */
export const TRANSACTION_ROUTES = {
  /** GET 我的交易列表（游标分页，可按 role / status 过滤）。 */
  base: '/transactions',
  /** POST 买家发起交易确认（201，响应为写入的 SYSTEM MessageDto）。 */
  proposals: '/transactions/proposals',
  /** POST 卖家拒绝提案（200，响应为写入的 SYSTEM MessageDto）。 */
  reject: '/transactions/proposals/reject',
  /** GET 交易详情（仅交易双方，200 TransactionDto）。 */
  detail: (id: string) => `/transactions/${id}`,
  /** POST 卖家接受提案并创建交易（201 TransactionDto）；幂等保护由 LISTING_NOT_ACTIVE 兜底。 */
  accept: '/transactions',
  /** POST 双方确认面交（200 TransactionDto，幂等；第二侧确认触发 COMPLETED + listing SOLD）。 */
  confirm: (id: string) => `/transactions/${id}/confirm`,
  /** POST 取消（200 TransactionDto；COMPLETED 上 409 TRANSACTION_NOT_IN_PENDING）。 */
  cancel: (id: string) => `/transactions/${id}/cancel`,
  /** POST 卖家签发一次性面交码（201；明文仅在此响应返回）。 */
  issueMeetupToken: (id: string) => `/transactions/${id}/meetup-token`,
  /** GET 当前面交凭证状态（不返回明文码）。 */
  meetupTokenStatus: (id: string) => `/transactions/${id}/meetup-token`,
  /** POST 使用二维码凭证。 */
  redeemMeetupToken: (id: string) => `/transactions/${id}/meetup-token/redeem`,
  /** POST 使用 6 位手动码。 */
  verifyMeetupCode: (id: string) => `/transactions/${id}/meetup-token/verify-code`,
} as const
