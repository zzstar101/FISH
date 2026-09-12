import { realtimeClientEventSchema } from '@fish/contracts/chat/schema'
import { errorBody } from '@fish/contracts/system/error'
import type { Context } from 'hono'
import type { ConnectionHub } from './hub'

/** hono/bun WS 事件的必要子集；真实 WsContext 满足该面。 */
export interface WsLike {
  send(data: string): void
}

export type WsEventHandlers = {
  onOpen(event: unknown, ws: WsLike): void
  onMessage(event: { data: unknown }, ws: WsLike): void
  onClose(event: unknown, ws: WsLike): void
}

export type RealtimeRouterOptions = {
  hub: ConnectionHub
  /**
   * upgrade 握手时的身份解析（契约冻结语义①）：与 HTTP 的 requireAuth 同一套
   * cookie + session（app.ts 注入 auth.resolveViewerId），不存在第二个认证入口。
   */
  resolveUserId: (c: Context) => Promise<string | null>
  /**
   * hono/bun 的 upgradeWebSocket 与 Bun.serve 的 `websocket` 处理器必须来自同一
   * createBunWebSocket 实例（apps/api/src/ws.ts）。依赖注入是为了测试可以用
   * 自己的一对实例起真实 Bun.serve。
   */
  upgradeWebSocket: (
    createEvents: (c: Context) => WsEventHandlers,
    // biome-ignore lint/suspicious/noConfusingVoidType: hono 的 MiddlewareHandler 返回类型就是 Promise<Response | void>
  ) => (c: Context, next: () => Promise<void>) => Promise<Response | void>
}

/**
 * 业务实时通道（#9 契约冻结的三条语义）：
 * ① cookie 鉴权；② 未认证在 upgrade 前拒绝（HTTP 401，连接不会建立）；
 * ③ 服务端把该用户全部会话的新消息推给其所有连接——本 router 负责登记与保活，
 * message.new 由 messages 服务经 hub 推送（先落库，再推送）。
 *
 * 客户端 P0 只有 ping → 服务端 pong；其余帧（含解析失败）静默忽略，不因坏帧断连。
 */
export function createRealtimeRouter(options: RealtimeRouterOptions) {
  const { hub, resolveUserId } = options
  // onOpen 时把 hub.attach 返回的注销函数与该连接配对保存，onClose 时取出执行。
  const detachments = new WeakMap<object, () => void>()

  const wsHandler = options.upgradeWebSocket((c) => ({
    onOpen(_event: unknown, ws: WsLike) {
      const userId = c.get('userId') as string
      detachments.set(ws, hub.attach(userId, ws))
    },
    onMessage(_event: { data: unknown }, ws: WsLike) {
      const parsed = realtimeClientEventSchema.safeParse(parseJson(_event.data))
      if (parsed.success && parsed.data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
      }
    },
    onClose(_event: unknown, ws: WsLike) {
      detachments.get(ws)?.()
      detachments.delete(ws)
    },
  }))

  return async function realtimeHandler(c: Context): Promise<Response> {
    const userId = await resolveUserId(c)
    if (!userId) {
      // 契约冻结语义②：在 upgrade 前拒绝。浏览器侧表现为 onerror/onclose，
      // 不存在"连上后再收错误帧"的状态。
      return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    }
    c.set('userId', userId)

    const response = await wsHandler(c, async () => {})
    if (!response) {
      throw new Error('WebSocket upgrade 失败：upgradeWebSocket 未产生响应')
    }
    return response
  }
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
