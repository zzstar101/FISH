import type { SubscribeMessageKind } from '@fish/contracts/subscribe-messages/schema'
import type { Db } from '@fish/db/client'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { SubscribeMessageClient } from './client'
import type { SubscribeMessageCapability } from './service'
import {
  type ChatDeliverySource,
  createSqlSubscribeMessageStore,
  type NotificationDeliverySource,
  type SubscribeMessageStore,
} from './store'
import {
  chatDeliveryContent,
  notificationDeliveryContent,
  type SubscribeDeliveryContent,
} from './templates'

/**
 * 订阅消息的**投递调度**（#462）：在 API 进程里跑的一个循环。
 *
 * ## 为什么在 API 而不是 worker
 *
 * 唯一的 `WechatAccessTokenService` 实例（#294）在 API 进程里 —— 一个 appid 在微信侧只有
 * 一份有效凭证，再在 worker 建第二个就会有两条刷新循环互相作废对方刚取到的 token
 * （`access-token.ts` 的注释写明了这条）。所以投递只能贴着那唯一的凭证服务跑。
 *
 * ## 每一轮做三件事
 *
 * 1. **登记**（不动现有写入点）：把 `notifications` 里新产生的 TX / DISPUTE / MODERATION /
 *    ACCOUNT 通知、以及「对方发来 60 秒还没读」的聊天消息，按映射写成投递行。
 *    去重靠 `(source_type, source_id, recipient_id)` 唯一键 + `ON CONFLICT DO NOTHING`，
 *    所以这一轮扫到重复的、进程重启后重扫的都只会留一行。
 * 2. **发送**：取到点待发的行，逐条在事务里"占行 → 校验额度 → 调微信 → 落状态"。
 * 3. **永不影响业务**：整个 `runOnce` 不抛异常，任何一步失败只记脱敏日志（不含 openid /
 *    token / 消息内容）。交易与站内通知早已落库，投递只是站外提醒。
 *
 * ## 窗口为什么都是有界的
 *
 * 三条扫描都带时间窗（通知 30 分钟、聊天 10 分钟），不是"从开天辟地扫起"：进程重启后
 * 把两小时前的「订单已接受」推给用户是打扰而不是提醒，而窗口内漏掉的（API 停机）本来也
 * 已经时过境迁 —— 端上打开小程序就能看到站内通知。
 */

/** 调度间隔。15 秒：CHAT 的门槛是"60 秒还没读"，比它快一个量级就够灵敏了。 */
export const SUBSCRIBE_SCHEDULER_INTERVAL_MS = 15_000

/** 通知登记窗口：只看最近 30 分钟（见文件头「窗口为什么都是有界的」）。 */
export const NOTIFICATION_LOOKBACK_MS = 30 * 60 * 1000

/** 聊天登记窗口：10 分钟。CHAT 门槛是 60 秒，10 分钟已经给停机留了足够余量。 */
export const CHAT_LOOKBACK_MS = 10 * 60 * 1000

/** 「对方消息未读」的判定延迟：消息发出后 60 秒内没被读才推。 */
export const CHAT_UNREAD_DELAY_MS = 60_000

/** CHAT 的限频窗口：同一「会话 × 收件人」30 分钟内最多推 1 条（Owner 冻结口径）。 */
export const CHAT_THROTTLE_MS = 30 * 60 * 1000

/** 每轮最多登记多少条来源（防止一次启动把整表扫进内存）。 */
const REGISTER_BATCH = 100

/** 每轮最多发多少条（每条一个 5 秒超时的上游调用；10 条已远小于 15 秒的间隔）。 */
const SEND_BATCH = 10

export type SubscribeSchedulerRun = {
  /** 本轮新登记的投递行数（去重后真正插入的）。 */
  registered: number
  sent: number
  skipped: number
  failed: number
  retry: number
}

export type SubscribeMessageScheduler = {
  /** 启动循环。能力关闭时只记一行日志、不建定时器（可重复调用，幂等）。 */
  start(): void
  /** 停止循环（进程退出时由 `index.ts` 调）。可重复调用。 */
  stop(): void
  /** 跑一轮（测试与手工触发用；循环每 `intervalMs` 调一次）。**不抛异常**。 */
  runOnce(): Promise<SubscribeSchedulerRun>
}

export function createSubscribeMessageScheduler(deps: {
  db: Db
  /** `null` = 能力关闭（没模板或 `WECHAT_TRANSPORT != live`）。 */
  client: SubscribeMessageClient | null
  capability: SubscribeMessageCapability
  now?: () => Date
  intervalMs?: number
  /** 注入点：单测接管日志，避免往 stdout 里写噪声。 */
  log?: (message: string, detail?: unknown) => void
  store?: SubscribeMessageStore
}): SubscribeMessageScheduler {
  const store = deps.store ?? createSqlSubscribeMessageStore(deps.db)
  const now = deps.now ?? (() => new Date())
  const intervalMs = deps.intervalMs ?? SUBSCRIBE_SCHEDULER_INTERVAL_MS
  const log = deps.log ?? ((message: string) => console.error(message))

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  /**
   * 登记通知来源。返回新插入的行数。
   *
   * 一次批量取标题再统一映射：`payload` 里只有商品 UUID，逐条查标题会变成 N+1；
   * 而列表里的商品标题是**渲染时**的快照（见 schema 注释）。
   */
  async function registerNotifications(at: Date): Promise<number> {
    const since = new Date(at.getTime() - NOTIFICATION_LOOKBACK_MS)
    const sources = await store.listNotificationSources(since, REGISTER_BATCH)
    if (sources.length === 0) return 0

    const listingIds = sources
      .map((source) => source.payload.listingId)
      .filter((id): id is string => typeof id === 'string')
    const titles = await store.findListingTitles(listingIds)

    const rows = sources.flatMap((source) => {
      const content = renderNotification(source, titles)
      if (content === null) return []
      return [
        {
          sourceType: 'NOTIFICATION' as const,
          sourceId: source.id,
          recipientId: source.userId,
          kind: content.kind,
          data: content.data,
          page: content.page,
          conversationId: null,
        },
      ]
    })

    return store.insertDeliveries(rows)
  }

  /** 映射一条通知；渲染不出可打开页面的返回 `null`（宁可不发，见 templates.ts 注释）。 */
  function renderNotification(
    source: NotificationDeliverySource,
    titles: Map<string, string>,
  ): SubscribeDeliveryContent | null {
    const listingId = source.payload.listingId
    return notificationDeliveryContent({
      type: source.type,
      payload: source.payload,
      createdAt: source.createdAt,
      listingTitle: typeof listingId === 'string' ? (titles.get(listingId) ?? null) : null,
      transactionId: tryEncode(PUBLIC_ID_PREFIX.transaction, source.payload.transactionId),
      conversationId: tryEncode(PUBLIC_ID_PREFIX.conversation, source.payload.conversationId),
      listingId: tryEncode(PUBLIC_ID_PREFIX.listing, listingId),
    })
  }

  /** 登记聊天未读来源，返回新插入的行数。 */
  async function registerChat(at: Date): Promise<number> {
    const sources = await store.listChatSources({
      since: new Date(at.getTime() - CHAT_LOOKBACK_MS),
      unreadBefore: new Date(at.getTime() - CHAT_UNREAD_DELAY_MS),
      throttleSince: new Date(at.getTime() - CHAT_THROTTLE_MS),
      limit: REGISTER_BATCH,
    })
    if (sources.length === 0) return 0

    const rows = sources.map((source) => chatRow(source))
    return store.insertDeliveries(rows)
  }

  function chatRow(source: ChatDeliverySource) {
    const content = chatDeliveryContent({
      conversationId:
        tryEncode(PUBLIC_ID_PREFIX.conversation, source.conversationId) ?? source.conversationId,
      senderNickname: source.senderNickname,
      // 会话关联的商品可能已被物理删除（`listing_title` 为 NULL）：模板里给个中性占位，
      // 不能因此把整条提醒丢掉。
      listingTitle: source.listingTitle ?? '',
      messageCreatedAt: source.messageCreatedAt,
    })
    return {
      sourceType: 'CHAT' as const,
      sourceId: source.messageId,
      recipientId: source.recipientId,
      kind: content.kind,
      data: content.data,
      page: content.page,
      // 限频维度用**库里**的 UUID（不是公开 ID）：索引列是 `uuid`。
      conversationId: source.conversationId,
    }
  }

  /** 发一批到点的行。逐条独立事务：一条失败不影响其余。 */
  async function sendPending(at: Date): Promise<Omit<SubscribeSchedulerRun, 'registered'>> {
    const counts = { sent: 0, skipped: 0, failed: 0, retry: 0 }
    const client = deps.client
    if (client === null) return counts

    const ids = await store.listPendingDeliveryIds(at, SEND_BATCH)
    for (const id of ids) {
      try {
        const result = await store.attemptDelivery(id, at, async (delivery) => {
          // 发之前的两道本地门禁：没有微信身份、或该 kind 的模板在本次发版后被摘掉。
          const templateId = deps.capability.templateIds[delivery.kind]
          if (templateId === null) {
            return { ok: false, reason: 'skip', detail: 'no_template' }
          }
          const openid = await store.findOpenid(delivery.recipientId)
          if (openid === null) return { ok: false, reason: 'skip', detail: 'no_openid' }

          return client.send({
            openid,
            templateId,
            page: delivery.page,
            data: delivery.data,
          })
        })
        if (result.outcome === 'sent') counts.sent += 1
        else if (result.outcome === 'skipped') counts.skipped += 1
        else if (result.outcome === 'failed') counts.failed += 1
        else if (result.outcome === 'retry') counts.retry += 1
        // `gone` / `not-due`：另一个 tick 抢先或还没到点，不算失败。
      } catch (error) {
        // 事务级异常（如数据库抖动）：只记类型，不记内容。
        log('[api] 订阅消息投递失败', error instanceof Error ? error.name : 'unknown')
      }
    }
    return counts
  }

  async function runOnce(): Promise<SubscribeSchedulerRun> {
    const empty: SubscribeSchedulerRun = {
      registered: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      retry: 0,
    }
    if (deps.client === null || !deps.capability.enabled) return empty
    // 单飞：上一轮还没跑完（比如一批超时累积）就跳过这一轮，避免并发 tick 抢同一批行。
    if (running) return empty
    running = true

    try {
      const at = now()
      let registered = 0
      // 两段登记各自独立：聊天那边查挂了不该让通知也停摆。
      try {
        registered += await registerNotifications(at)
      } catch (error) {
        log('[api] 订阅消息登记通知失败', error instanceof Error ? error.name : 'unknown')
      }
      try {
        registered += await registerChat(at)
      } catch (error) {
        log('[api] 订阅消息登记聊天失败', error instanceof Error ? error.name : 'unknown')
      }

      const sent = await sendPending(at)
      return { registered, ...sent }
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (deps.client === null || !deps.capability.enabled) {
        log('[api] 微信订阅消息未开通（缺模板或 WECHAT_TRANSPORT!=live），投递循环不启动')
        return
      }
      if (timer !== null) return
      timer = setInterval(() => {
        // `runOnce` 自己吞异常，但定时器回调里仍兜一层：任何漏网异常不该打死进程。
        void runOnce().catch((error: unknown) => {
          log('[api] 订阅消息调度轮次异常', error instanceof Error ? error.name : 'unknown')
        })
      }, intervalMs)
      // 不让这个定时器拖住进程退出（`stop()` 仍会显式清掉）。
      timer.unref?.()
      log(`[api] 微信订阅消息投递循环已启动（每 ${Math.round(intervalMs / 1000)} 秒一轮）`)
    },

    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },

    runOnce,
  }
}

/** 编公开 ID；`payload` 里的脏值（形状不对 / 非 v7）一律当没有，绝不让它打断整轮扫描。 */
function tryEncode(prefix: Parameters<typeof encodePublicId>[0], id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return null
  try {
    return encodePublicId(prefix, id)
  } catch {
    return null
  }
}

/** 便于测试与文档引用：首批三个 kind（顺序即 `GET config` 的键顺序）。 */
export const SUBSCRIBE_MESSAGE_KINDS: readonly SubscribeMessageKind[] = ['CHAT', 'TX', 'REVIEW']
