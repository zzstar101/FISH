import { type RealtimeServerEvent, realtimeServerEventSchema } from '@fish/contracts/chat/schema'

/**
 * 连接上的最小发送面。真实 WS 连接（hono/bun 的 WsContext）都满足；
 * 收敛成接口是为了 hub 可以脱离真实 socket 做单元测试。
 */
export interface WsSender {
  send(data: string): void | Promise<void>
}

/**
 * 在线连接登记表（#9 契约的推送语义：服务端把当前用户参与的全部会话推给该用户的所有连接）。
 *
 * - 同一用户可以有多个连接（多标签页 / 多设备），全部推送；
 * - 推送前经契约 schema 校验：事件形状违规在服务端炸掉，而不是把残缺 JSON 发给前端；
 * - 发送失败不抛出：单个连接的死亡（对端已断开等）不应影响其他接收者，由 onClose 负责清理。
 */
export interface ConnectionHub {
  /** 登记连接，返回注销函数（onClose 时调用）。 */
  attach(userId: string, sender: WsSender): () => void
  /** 把事件推给这些用户的全部在线连接。 */
  pushToUsers(userIds: readonly string[], event: RealtimeServerEvent): void
  /** 当前在线连接总数（测试 / 观测用）。 */
  connectionCount(): number
}

export function createConnectionHub(): ConnectionHub {
  // userId → 该用户的在线连接集合；Set 天然去重，连接关闭时必须显式 remove
  const connections = new Map<string, Set<WsSender>>()

  return {
    attach(userId, sender) {
      let set = connections.get(userId)
      if (!set) {
        set = new Set()
        connections.set(userId, set)
      }
      set.add(sender)
      return () => {
        set.delete(sender)
        if (set.size === 0) connections.delete(userId)
      }
    },

    pushToUsers(userIds, event) {
      // 服务端出口的唯一形状保证点：契约事件在此 parse，违规即 500（app.onError），
      // 与 DTO 读模型的 zod parse 同一取向。
      const payload = JSON.stringify(realtimeServerEventSchema.parse(event))
      for (const userId of userIds) {
        for (const sender of connections.get(userId) ?? []) {
          try {
            void sender.send(payload)
          } catch {
            // 对端已断开等发送失败：忽略，等 onClose 清理。
          }
        }
      }
    },

    connectionCount() {
      let count = 0
      for (const set of connections.values()) count += set.size
      return count
    },
  }
}
