/**
 * Block Domain 路由常量（Issue #466）。
 *
 * 这些是 **API 侧路径**（根级），与 `follows/routes.ts` 同口径：前端 typed client 与
 * API router 共用本文件，禁止在别处硬编码这些路径。
 *
 * 两条路径都要求登录：拉黑关系是「我」与某个人的有向边，读与写都不匿名。
 * 未登录 401 `UNAUTHENTICATED`；目标不存在 404 `USER_NOT_FOUND`；拉黑自己
 * 422 `CANNOT_BLOCK_SELF`（与 follows 的自关注同构，DB CHECK 兜底）。
 *
 * **拉黑的语义在服务端，端上只负责入口与管理**：建立拉黑后，既有会话的双方都不能
 * 再发送消息（文本 / 商品卡 / 媒体）、也**双向**不能新建会话；交易系统消息（SYSTEM）
 * 与面交流程不受影响；解除后双向恢复。历史消息保留可见。这些守卫在 chat 域的
 * service 层实现（`blocks` store 的 `existsBlockBetween`），端上没有任何「绕过」路径。
 */
export const BLOCK_ROUTES = {
  /**
   * GET 我拉黑的人（`user_blocks.created_at DESC, users.id DESC`，不透明游标分页）。
   *
   * 响应 `{ items, nextCursor }`：只列**我拉黑的**（我的视角），不提供「谁拉黑了我」
   * 的任何读取路径——那会让被拉黑变成可探测的状态。
   */
  myBlocks: '/me/blocks',
  /**
   * 与某个人的拉黑关系：GET 读状态、POST 拉黑、DELETE 解除，三条同一个资源路径。
   *
   * POST / DELETE 幂等（重复拉黑 / 重复解除都 200，不改写首次 created_at），
   * 响应回 `{ blocked }` 服务端结论，端上不本地翻转。
   */
  blockRelation: (userId: string) => `/users/${userId}/block`,
} as const
