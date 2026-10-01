import { PRESENCE_ONLINE_TTL_MS, type UserPresence } from '@fish/contracts/users/schema'

/**
 * 用户在线态登记表（#359 第五点）。
 *
 * ## 口径：已认证活动 + TTL，而不是「WebSocket 连接还在不在」
 *
 * 本仓当前**只有 web-pc 有实时客户端**（`apps/web-pc/src/features/chat/realtime.ts`），
 * 小程序端没有（#213→#220 链未合入 main）。若把在线态定义成「WS 连接数 > 0」，端上
 * 永远没有人在线 —— 而 Owner 要的三处展示位（他人主页 / 聊天页顶部栏 / 商品详情卖家行）
 * 全在小程序端。所以这里的定义是：
 *
 * - **活动**：任何一次已认证请求（HTTP）或 WS 保活帧，经 `touch(userId)` 记下时刻；
 * - **在线**：读取这一刻 `now - lastActiveAt < PRESENCE_ONLINE_TTL_MS`。
 *
 * 由此「离线」不需要任何服务端事件：TTL 到期的瞬间没有任何请求可依附，客户端用
 * **同一个 TTL 常量**在本地过期即可（契约注释见 `users/schema.ts` 的 `PRESENCE_ONLINE_TTL_MS`）。
 *
 * ## 单实例内存，够用且刻意
 *
 * 本仓明确排除 Redis（根 `AGENTS.md` 第 3 节），API 当前是单实例，所以进程内 Map 就是
 * 权威（Issue #359 第五点原文：「内存即可」）。代价必须写清楚：
 * **进程重启会丢掉全部 `lastActiveAt`**，重启后到第一次活动之间，所有用户的
 * `presenceOf` 都返回 `{ online: false, lastActiveAt: null }`（客户端渲染成「离线」，
 * 不会编造一个假的「最后活跃」时刻）。多实例部署时这里必须换成共享存储，否则
 * 「A 连到实例 1、B 连到实例 2」会互相看不见 —— 本轮不做，属于多实例化那一次的事。
 *
 * ## 为什么 `touch` 只在「离线 → 在线」时回调
 *
 * 广播（`presence.changed`）的语义是「状态变了」，而在线→在线的高频活动（每个 HTTP
 * 请求）不该刷屏。所以只有跨过 TTL 窗口重新变在线的那一刻才回调一次；反过来
 * 「在线 → 离线」由客户端按同一 TTL 本地过期（见上）。
 */
export interface PresenceReader {
  /** 读模型：DTO 富化用（会话对方 / 公开资料）。纯读，无副作用。 */
  presenceOf(userId: string): UserPresence
}

export interface PresenceRegistry extends PresenceReader {
  /**
   * 记一次已认证活动（HTTP 请求或 WS 保活）。幂等：重复调用只推进时刻。
   * 该用户**此前不在线**时触发一次 `onChange`（离线 → 在线）。
   */
  touch(userId: string): void
  /** 登记表里有多少个被 touch 过的用户（观测 / 测试用）。 */
  trackedCount(): number
}

export interface CreatePresenceRegistryOptions {
  /** 离线 → 在线时调用一次（装配层据此向会话对方广播 `presence.changed`）。 */
  onChange?: (userId: string, presence: UserPresence) => void
  /** 注入时钟（测试用）；缺省 `Date.now`。 */
  now?: () => number
  /** 在线窗口；缺省契约常量（客户端本地过期用同一个值）。 */
  ttlMs?: number
}

export function createPresenceRegistry(
  options: CreatePresenceRegistryOptions = {},
): PresenceRegistry {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? PRESENCE_ONLINE_TTL_MS
  /**
   * 最后一次已认证活动的时刻（毫秒）。
   *
   * 不清理过期条目：条目数与「进程启动以来活动过的用户数」同阶，每个约几十字节；
   * 为它加一个清扫定时器反而要引入生命周期（谁启动、谁停）与并发边界，不值。
   * 真到了内存意义上的用户量级，这里本来就要换共享存储（见文件头）。
   */
  const lastActiveAt = new Map<string, number>()

  /** 读取 `at` 这一刻的快照。`lastActiveAt` 恒为**最后一次活动**（在线时也照给）。 */
  function snapshotOf(userId: string, at: number): UserPresence {
    const activeAt = lastActiveAt.get(userId)
    const online = activeAt !== undefined && at - activeAt < ttlMs
    return {
      online,
      lastActiveAt: activeAt === undefined ? null : new Date(activeAt).toISOString(),
    }
  }

  return {
    presenceOf(userId) {
      return snapshotOf(userId, now())
    },

    touch(userId) {
      const at = now()
      // 先判「此前在不在线」再写时刻：写完之后必然在线，判不出转变。
      const wasOnline = snapshotOf(userId, at).online
      lastActiveAt.set(userId, at)
      if (!wasOnline) options.onChange?.(userId, snapshotOf(userId, at))
    },

    trackedCount() {
      return lastActiveAt.size
    },
  }
}
