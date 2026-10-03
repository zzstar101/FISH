/**
 * Transaction Review Domain 路由常量（Issue #195 PR2）。
 *
 * 这些是 **API 侧路径**（根级），与 `comments/routes.ts` 同口径：前端 typed client 与
 * API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 评价是**交易双方的私有成交证据**：两个端点都整挂 `requireAuth`，且「非参与者」与
 * 「交易不存在」同码 404（transactions 域的既定口径，不给交易 id 的存在性留探针）。
 */
export const TRANSACTION_REVIEW_ROUTES = {
  /**
   * 「(我, 这笔交易)」这条评价边：**GET 读我的 / POST 创建 / DELETE 删除**三条方法落在
   * 同一个 URL 上（favorites 的 `favoriteRelation` 同款形态）。
   *
   * 资源身份是 `(transaction_id, author_id)`，本人在一笔交易下最多一条 —— 端上不必记住
   * 评价行的 id，交易 id 就是地址。POST **幂等保护靠 409** 而不是静默 200：评价带内容，
   * 与「收藏」这类无内容幂等写不同，重复提交应该被看见而不是被吞掉。
   */
  reviewEdge: (transactionId: string) => `/transactions/${transactionId}/review`,
  /**
   * `GET` 一笔交易的**两方**评价（订单详情对账用：对方评了没、评了什么）。
   *
   * 仅交易参与者可读（非参与者 404）；至多两行（buyer 一条 + seller 一条），不分页。
   */
  ofTransaction: (transactionId: string) => `/transactions/${transactionId}/reviews`,
} as const
