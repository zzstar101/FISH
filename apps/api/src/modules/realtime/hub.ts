import {
  type MediaRealtimeEvent,
  mediaRealtimeEventSchema,
  type RealtimeServerEvent,
  realtimeServerEventSchema,
} from '@fish/contracts/chat/schema'

/**
 * 连接上的最小发送面。真实 WS 连接（hono/bun 的 WsContext）都满足；
 * 收敛成接口是为了 hub 可以脱离真实 socket 做单元测试。
 */
export interface WsSender {
  send(data: string): void | Promise<void>
  /**
   * 主动断开这条连接（#464 用）。真实 socket（hono/bun 的 WsContext）提供 `close()`；
   * 声明成可选是为了让测试里的假 sender 不必都实现它 —— 不实现时 `closeUser` 只摘登记，
   * 断言仍能看「连接是否还在表里」。
   */
  close?(): void
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
  /** 把旧版事件推给这些用户的全部在线连接。 */
  pushToUsers(userIds: readonly string[], event: RealtimeServerEvent): void
  /** #67 媒体事件独立出口，避免让未接入媒体的旧客户端解析失败。 */
  pushMediaToUsers(userIds: readonly string[], event: MediaRealtimeEvent): void
  /**
   * 断开某个用户的**全部**连接，返回被断开的条数（#464）。
   *
   * 账号注销的两处需要它：申请时刻（撤销其他设备会话后，那些设备上的 WS 必须一起断，
   * 否则它们仍能收到推送、像是还登录着）与去标识化完成时刻（凭据已清空，任何推送都无意义）。
   * 断连之后客户端会自动重连，重连走的是同一套 cookie + session 解析，于是被撤销的会话
   * 在 upgrade 阶段就被 401 拦掉 —— 不需要在 WS 层再实现一套权限判断。
   */
  closeUser(userId: string): number
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
        // 只在「当前登记的仍是这一个 Set」时摘除映射：#464 的 closeUser 会把整条映射先删掉，
        // 之后该用户重连会建一个**新的** Set。此时旧连接的 onClose 若不加这层身份判断，
        // 就会把新 Set 从映射里摘掉 —— 新连接从此收不到任何推送（且没有任何报错）。
        if (set.size === 0 && connections.get(userId) === set) connections.delete(userId)
      }
    },

    closeUser(userId) {
      const set = connections.get(userId)
      if (!set) return 0
      connections.delete(userId)
      const senders = [...set]
      for (const sender of senders) {
        try {
          sender.close?.()
        } catch {
          // 对端已经断开等情况：忽略，连接的清理是幂等的（登记已摘除）。
        }
      }
      return senders.length
    },

    pushToUsers(userIds, event) {
      push(userIds, JSON.stringify(realtimeServerEventSchema.parse(event)))
    },

    pushMediaToUsers(userIds, event) {
      push(userIds, JSON.stringify(mediaRealtimeEventSchema.parse(event)))
    },

    connectionCount() {
      let count = 0
      for (const set of connections.values()) count += set.size
      return count
    },
  }

  function push(userIds: readonly string[], payload: string): void {
    for (const userId of userIds) {
      for (const sender of connections.get(userId) ?? []) {
        try {
          void sender.send(payload)
        } catch {
          // 对端已断开等发送失败：忽略，等 onClose 清理。
        }
      }
    }
  }
}
