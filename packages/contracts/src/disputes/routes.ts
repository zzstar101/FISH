/**
 * Disputes Domain 路由常量（#465，用户端）。
 *
 * 这些是 **API 侧路径**（根级 `/disputes`），口径与 reports / listings 一致：
 * **API 路径不含浏览器前缀**。管理端的争议路径（`/admin/disputes`…）不在本文件——
 * 按 moderation / reports 的先例放在 `packages/contracts/src/admin/routes.ts` 的
 * `ADMIN_ROUTES` 里，保持「`/admin` 下所有路径只有一个来源」。
 *
 * 刻意**没有**「按交易查争议」的公开端点：`GET /disputes/mine` 是唯一列表入口，
 * 一条争议的详情对非当事人恒 404。
 */
export const DISPUTE_ROUTES = {
  base: '/disputes',
  /** POST 从本人订单发起争议。重复提交同一方向同一交易返回已存在的那条（200）。 */
  create: '/disputes',
  /** GET 「我的争议」（我发起的 + 我被诉的，游标分页）。 */
  mine: '/disputes/mine',
  /** GET 争议详情（含附件与证据）。 */
  detail: (disputeId: string) => `/disputes/${disputeId}`,
  /** POST 发起人撤回未决争议（终态，不可复活）。 */
  withdraw: (disputeId: string) => `/disputes/${disputeId}/withdraw`,
  /** POST 附件直传预签名。 */
  attachmentPresign: (disputeId: string) => `/disputes/${disputeId}/attachments/presign`,
  /** POST 确认附件（写入台账，返回授权读取 URL）。 */
  attachmentConfirm: (disputeId: string) => `/disputes/${disputeId}/attachments`,
  /** POST 关联一条聊天消息作为证据（只回单条消息，绝不返回整段会话）。 */
  evidenceMessages: (disputeId: string) => `/disputes/${disputeId}/evidence-messages`,
} as const
