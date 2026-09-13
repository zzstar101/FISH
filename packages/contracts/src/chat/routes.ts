/**
 * Chat Domain 路由常量（Issue #9）。
 *
 * HTTP 路径是 **API 侧路径**（根级）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉前缀；
 * WebSocket 例外：`/ws/*` 由 Vite 原样透传（`apps/web/vite.config.ts` 的 `/ws` 代理项不做
 * rewrite），因此 `REALTIME_WS_PATH` 已是 Web 直连的完整路径。
 *
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 */
export const CHAT_ROUTES = {
  /**
   * POST 创建/复用会话：同一 (listingId, 买家) 复用既有会话——新建 201、复用 200
   * （复用即幂等，不另设返回字段），响应体均为 ConversationDto。
   * 对任意已存在的商品都可建会话（不限制 ACTIVE）：商品 OFFLINE/SOLD 后买卖双方
   * 仍可能需要沟通；「我想要」入口只在 ACTIVE 详情页出现，属于前端的事。
   * GET 拉当前用户的会话列表（买卖两种角色合并，按 lastMessageAt 降序，游标分页）。
   */
  base: '/conversations',
  /** GET 历史消息（游标分页，升序）；POST 发送 TEXT 消息（201，响应体 MessageDto）。 */
  messages: (id: string) => `/conversations/${id}/messages`,
  /**
   * 标记会话已读：把查看者的 last_read_at 推进到当前时刻，
   * 返回未读归零后的 ConversationDto（200）。
   */
  read: (id: string) => `/conversations/${id}/read`,
} as const

/** 业务实时推送端点（`apps/api/src/modules/realtime`）；root 层接线由 Platform Owner 完成。 */
export const REALTIME_WS_PATH = '/ws/chat'
