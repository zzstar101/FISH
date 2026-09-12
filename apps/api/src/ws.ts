import { createBunWebSocket } from 'hono/bun'

/**
 * 最小 WebSocket 测试入口（echo 回显），仅用于验证连接链路。
 * 业务实时能力（会话消息、匹配推送）由 #9 / #8 在 modules/realtime 下建立。
 */
export const { upgradeWebSocket, websocket } = createBunWebSocket()
