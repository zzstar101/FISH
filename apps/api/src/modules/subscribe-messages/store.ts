import {
  SUBSCRIBE_MESSAGE_GRANT_LIMIT,
  type SubscribeMessageKind,
} from '@fish/contracts/subscribe-messages/schema'
import type { Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import { conversations } from '@fish/db/schema/conversations'
import { listings } from '@fish/db/schema/listings'
import { messages } from '@fish/db/schema/messages'
import type { NotificationPayload, NotificationType } from '@fish/db/schema/notifications'
import { notifications } from '@fish/db/schema/notifications'
import {
  type SubscribeMessageDeliveryStatus,
  type SubscribeMessageSourceType,
  subscribeMessageDeliveries,
  subscribeMessageGrants,
} from '@fish/db/schema/subscribe-messages'
import { transactions } from '@fish/db/schema/transactions'
import { users, wechatIdentities } from '@fish/db/schema/users'
import { and, desc, eq, gt, inArray, isNull, lte, ne, notExists, or, sql } from 'drizzle-orm'
import { type AttemptSignal, planAttempt } from './outcome'

/**
 * 微信订阅消息的持久化层（#462）：授权记账 + 投递行。
 *
 * 两张表的分工见 `packages/db/src/schema/subscribe-messages.ts` 的注释；本文件只负责
 * 「怎么读写」，四条口径写在这里：
 *
 * 1. **登记一律 `ON CONFLICT DO NOTHING`**，不先查后写。去重键是
 *    `(source_type, source_id, recipient_id)`，它同时是"重启后重扫"与"两个 tick 交错"的
 *    防线 —— 先查后写在两个并发 tick 之间仍然会各插一行。聊天另有一层：限频维度是
 *    「会话 × 收件人」，插入走 `insertChatDeliveries`（锁内复核窗口）。
 * 2. **发送不能与记账共用一个事务**（`attemptDelivery`）：先提交 `SENDING` 占位（含额度预扣），
 *    再调微信，最后单独提交结果。否则"上游已收、本地回滚"会让重启后重复发送。
 * 3. **占位用 `FOR UPDATE SKIP LOCKED`**：同一个 tick 不会把同一条发两遍，两个 tick 也不会。
 * 4. **额度扣减是原子的**（`UPDATE … WHERE remaining > 0`）：跨事务之后不能再靠行锁把
 *    "同一人同一 kind"串起来，所以"判额度 + 扣"必须在同一条语句里。
 */

/** 每个 kind 的剩余次数；没有行 = 0（`grant` 表只在用户「允许」过之后才有行）。 */
export type SubscribeRemaining = Record<SubscribeMessageKind, number>

/** 一条待登记的投递内容（渲染已在 `templates.ts` 完成，这里只搬字段）。 */
export type NewSubscribeDelivery = {
  sourceType: SubscribeMessageSourceType
  sourceId: string
  recipientId: string
  kind: SubscribeMessageKind
  data: Record<string, string>
  page: string
  /** 仅 CHAT 有值：`(conversation_id, recipient_id, created_at)` 是 30 分钟限频的索引列。 */
  conversationId?: string | null
}

/** 一条待投递的 `notifications` 行（已按类型收窄，只带登记需要的字段）。 */
export type NotificationDeliverySource = {
  id: string
  userId: string
  type: NotificationType
  payload: NotificationPayload
  createdAt: Date
}

/** 一条「对方发了、我还没读」的消息。`recipientId` 已由 SQL 按买方/卖方算出。 */
export type ChatDeliverySource = {
  messageId: string
  conversationId: string
  recipientId: string
  senderNickname: string
  listingTitle: string | null
  messageCreatedAt: Date
}

/** 事务内被占住的投递行（发送只用得到这几列）。 */
export type LockedDelivery = {
  id: string
  recipientId: string
  kind: SubscribeMessageKind
  data: Record<string, string>
  page: string
  attempts: number
}

/** `attemptDelivery` 的结果。`gone` / `not-due` 都不是失败，只是"这一轮没轮到它"。 */
export type AttemptOutcome =
  | { outcome: 'sent' }
  | { outcome: 'skipped' }
  | { outcome: 'failed' }
  | { outcome: 'retry' }
  /** 行已被另一个 tick 占住，或已不是 `PENDING`。 */
  | { outcome: 'gone' }
  /** 退避还没到点（`next_attempt_at` 在将来），本轮跳过。 */
  | { outcome: 'not-due' }

export interface SubscribeMessageStore {
  /** 本人三个 kind 的剩余次数（缺行 = 0）。 */
  readRemaining(userId: string): Promise<SubscribeRemaining>
  /**
   * 用户「允许」后的记账：每个 kind +1，封顶 `limit`。
   *
   * 用 upsert 而不是"读-加-写"：并发上报（用户连点两次授权）下只有一次能生效在
   * 同一行上，SQL 里 `least(limit, remaining + 1)` 也不会因为竞争突破上限。
   */
  addAcceptedGrants(userId: string, kinds: SubscribeMessageKind[], limit: number): Promise<void>
  /** 批量登记投递行，返回真正新插入的行数（去重键冲突的静默跳过）。 */
  insertDeliveries(rows: NewSubscribeDelivery[]): Promise<number>
  /**
   * 登记 CHAT 投递行，返回真正新插入的行数。
   *
   * 与 `insertDeliveries` 分开的唯一原因：CHAT 的限频维度是「会话 × 收件人」，
   * 而 `(source_type, source_id, recipient_id)` 唯一键**拦不住同会话的两条不同消息**。
   * 所以这里在**一个事务里**先拿一把 advisory lock 把「限频复核 + 插入」串起来：
   * - 同一轮里已经按会话去重过（见 `listChatSources`），这是进程内的那半；
   * - 多实例部署时两个 API 会同时扫到同一批候选（各自的 `source_id` 不同），
   *   这一把锁让后到的那个在复核时看到先到者已提交的行，从而整批被限频窗口挡掉。
   *
   * `throttleSince` 由调用方按 `now - CHAT_THROTTLE_MS` 算好：窗口只有一份真相。
   */
  insertChatDeliveries(rows: NewSubscribeDelivery[], throttleSince: Date): Promise<number>

  /**
   * `notifications` 里**还没登记过投递**、且收件人有微信身份的行。
   *
   * 为什么要求收件人有微信身份：没有 openid 就没有"站外触达"这回事，登记出来的每一行
   * 都注定 SKIPPED —— 与其让投递表被这些行撑大，不如在登记这一步就不产生（发送时仍会
   * 重新查一次 openid，身份可能在登记之后被解绑）。
   */
  listNotificationSources(since: Date, limit: number): Promise<NotificationDeliverySource[]>
  /** 按商品 id 批量取标题（渲染 `thing` 字段用）；非法 id 由调用方先滤掉。 */
  findListingTitles(ids: string[]): Promise<Map<string, string>>
  /**
   * 按**交易 id** 批量取「该交易指向的商品」的标题（`DISPUTE` 通知用）。
   *
   * `DISPUTE` 的 payload 只有 `{ disputeId, transactionId, disputeEvent, resolution? }`
   * （生产者见 `apps/api/src/app.ts` 的 `notifyDispute`），**没有 `listingId`**：只按
   * `payload.listingId` 取标题的话，纠纷提醒的「商品名称」永远是兜底占位「交易商品」。
   * 一次批量 join 而不是逐条查，理由同 `findListingTitles`（避免 N+1）。
   */
  findTransactionListingTitles(ids: string[]): Promise<Map<string, string>>
  /**
   * 「对方发来的、收件人还没读」的消息（CHAT 投递的来源）。
   *
   * 判据都在 SQL 里，因为它们各自都要走索引（见 schema 的三个索引）：
   * - `unreadBefore` 之前：消息至少 60 秒了还没被读，才值得推（刚发出的不打扰）；
   * - 收件人一侧的 `last_read_at` 为空或早于消息：未读；
   * - 该消息还没为该收件人登记过（`source_type='CHAT'` + `source_id`）；
   * - `throttleSince` 之后该「会话 × 收件人」没有任何 CHAT 投递（30 分钟限频）。
   *
   * 每「会话 × 收件人」**只返回一条**（该会话最新那条未读消息）：限频的维度是会话×收件人，
   * 同一批里两条未读消息只该产出一条提醒（`distinct on` 在 SQL 里做，`limit` 因此是
   * 「最多多少个会话×收件人」而不是「最多多少条消息」）。
   */
  listChatSources(input: {
    since: Date
    unreadBefore: Date
    throttleSince: Date
    limit: number
  }): Promise<ChatDeliverySource[]>

  /** 到点待发的投递行 id（按 `next_attempt_at` 升序）。调用方逐条 `attemptDelivery`。 */
  listPendingDeliveryIds(now: Date, limit: number): Promise<string[]>
  /**
   * 一条投递的**一次尝试**：占位（提交）→ 发送（不持事务）→ 落状态（提交）。
   *
   * `send` 只做「调微信」这一件事（它拿到的 `LockedDelivery` 已含渲染好的 `data` / `page`）；
   * 决策全部由 `outcome.ts` 的 `planAttempt` 给，本方法只照抄。
   *
   * 发送前先把行标成 `SENDING` 并提交（#511 审查 high）：发送**不能**和"记账"共用一个事务 ——
   * 上游调用成功但本地事务回滚（进程被强杀），重启后会把同一条再发一遍。代价是这一步多一次
   * 提交与一次额度预扣/退回，换来"最多发一次"。
   */
  attemptDelivery(
    deliveryId: string,
    now: Date,
    send: (delivery: LockedDelivery) => Promise<AttemptSignal>,
  ): Promise<AttemptOutcome>

  /**
   * 把「发送中」且 `updated_at` 早于 `staleBefore` 的行判成 `FAILED`（`interrupted`），
   * 返回处理条数。
   *
   * 处理的是"进程在发送途中死掉"留下的孤儿行：那些行的结果**不确定**，宁可放弃也不重发。
   * 阈值由调用方给（必须远大于一次发送的最长耗时，否则会把另一个实例正在发的行误判）。
   */
  abandonStaleSending(now: Date, staleBefore: Date): Promise<number>

  /** 收件人的微信 openid；没有微信身份为 `null`。 */
  findOpenid(userId: string): Promise<string | null>
}

/** 登记 `notifications` 时关心的四类（`MATCH` 不在首批，SQL 里就排掉，不搬运）。 */
const NOTIFICATION_SOURCE_TYPES: NotificationType[] = ['TX', 'DISPUTE', 'MODERATION', 'ACCOUNT']

/** UUID 形状（`payload` 里的 id 是裸 UUID，但 jsonb 是自由字段：脏值一律当没有）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 聊天登记用的 advisory lock 键（`pg_advisory_xact_lock`，随事务结束自动释放）。
 *
 * 用**固定字符串**而不是按会话散列：限频是「每条会话×收件人各自一份」，但登记是批量的，
 * 按会话散列就得对每行单独加锁、且并发插入的顺序会影响封锁顺序（死锁风险）。这里的
 * 临界区只有一次索引查询 + 一次 insert（都在毫秒级），一把全局锁把它串起来最简单；
 * 这把锁只被订阅消息的聊天登记使用，不会与其它模块的 advisory lock 打架。
 */
const CHAT_REGISTER_LOCK_KEY = 'subscribe-message-chat-register'

/**
 * 「发送中被打断」时落进 `last_error` 的脱敏原因。
 *
 * 只有一种来路：进程在 `send` 飞行途中死了（强杀 / OOM / 断电），重启后由
 * `abandonStaleSending` 把这一行判成 FAILED。它**不代表微信拒收**，只代表我们不知道结果。
 */
export const SENDING_INTERRUPTED_ERROR = 'interrupted'

const EMPTY_REMAINING = (): SubscribeRemaining => ({ CHAT: 0, TX: 0, REVIEW: 0 })

export function createSqlSubscribeMessageStore(db: Db): SubscribeMessageStore {
  return {
    async readRemaining(userId) {
      const rows = await db
        .select({ kind: subscribeMessageGrants.kind, remaining: subscribeMessageGrants.remaining })
        .from(subscribeMessageGrants)
        .where(eq(subscribeMessageGrants.userId, userId))

      const remaining = EMPTY_REMAINING()
      for (const row of rows) remaining[row.kind] = row.remaining
      return remaining
    },

    async addAcceptedGrants(userId, kinds, limit) {
      const unique = [...new Set(kinds)]
      if (unique.length === 0) return
      await db
        .insert(subscribeMessageGrants)
        .values(unique.map((kind) => ({ userId, kind, remaining: 1 })))
        .onConflictDoUpdate({
          target: [subscribeMessageGrants.userId, subscribeMessageGrants.kind],
          // `excluded.remaining` 是本次 upsert 想插的 1：一条语句里多行 kind 各自只用得到自己的那份。
          set: {
            remaining: sql`least(${limit}, ${subscribeMessageGrants.remaining} + excluded.remaining)`,
            updatedAt: sql`clock_timestamp()`,
          },
        })
    },

    async insertDeliveries(rows) {
      return insertDeliveryRows(db, rows)
    },

    async insertChatDeliveries(rows, throttleSince) {
      if (rows.length === 0) return 0
      // 同一批里也按「会话 × 收件人」只留一条：本方法自己就该保证"一组一行"，
      // 不能把正确性寄托在调用方（候选查询已去重）身上。
      const byGroup = new Map<string, NewSubscribeDelivery>()
      for (const row of rows) {
        const key = chatGroupKey(row)
        if (!byGroup.has(key)) byGroup.set(key, row)
      }
      const unique = [...byGroup.values()]
      const conversationIds = [
        ...new Set(
          unique
            .map((row) => row.conversationId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ]
      if (conversationIds.length === 0) return 0
      const recipientIds = [...new Set(unique.map((row) => row.recipientId))]

      return db.transaction(async (tx) => {
        // ① 串行化「聊天登记」：进程内单飞挡不住另一个 API 实例的同时扫描，
        //    而两实例各自扫到的消息 `source_id` 不同，唯一键不会冲突 —— 只有这把锁
        //    能让后到的那个在 ② 的复核里看到先到者已提交的行。
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CHAT_REGISTER_LOCK_KEY}))`)

        // ② 锁内复核 30 分钟限频：窗口内已有 CHAT 投递行的「会话 × 收件人」整组丢弃。
        //    与 `listChatSources` 的 `throttled` 子查询同一判据（窗口内、任意状态都算），
        //    区别只是这一次读的是**已在锁内提交**的最新数据。
        const warmed = await tx
          .select({
            conversationId: subscribeMessageDeliveries.conversationId,
            recipientId: subscribeMessageDeliveries.recipientId,
          })
          .from(subscribeMessageDeliveries)
          .where(
            and(
              eq(subscribeMessageDeliveries.sourceType, 'CHAT'),
              inArray(subscribeMessageDeliveries.conversationId, conversationIds),
              inArray(subscribeMessageDeliveries.recipientId, recipientIds),
              gt(subscribeMessageDeliveries.createdAt, throttleSince),
            ),
          )
        const throttled = new Set(warmed.map((row) => `${row.conversationId}:${row.recipientId}`))
        const kept = unique.filter((row) => !throttled.has(chatGroupKey(row)))
        return insertDeliveryRows(tx, kept)
      })
    },

    async listNotificationSources(since, limit) {
      const alreadyRegistered = notExists(
        db
          .select({ one: sql`1` })
          .from(subscribeMessageDeliveries)
          .where(
            and(
              eq(subscribeMessageDeliveries.sourceType, 'NOTIFICATION'),
              eq(subscribeMessageDeliveries.sourceId, notifications.id),
            ),
          ),
      )

      return (
        db
          .select({
            id: notifications.id,
            userId: notifications.userId,
            type: notifications.type,
            payload: notifications.payload,
            createdAt: notifications.createdAt,
          })
          .from(notifications)
          // 没有微信身份就没有站外触达的对象（见接口注释）。
          .innerJoin(wechatIdentities, eq(wechatIdentities.userId, notifications.userId))
          .where(
            and(
              inArray(notifications.type, NOTIFICATION_SOURCE_TYPES),
              gt(notifications.createdAt, since),
              alreadyRegistered,
            ),
          )
          .orderBy(notifications.createdAt)
          .limit(limit)
      )
    },

    async findListingTitles(ids) {
      const valid = [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))]
      if (valid.length === 0) return new Map()
      // `payload` 里的 id 是自由 jsonb 文本：形状不对的一律当没有（否则 `::uuid` 会抛
      // 22P02 把整轮扫描打断）。数组元素已在上面滤过。
      const rows = await db
        .select({ id: listings.id, title: listings.title })
        .from(listings)
        .where(inArray(listings.id, valid))
      return new Map(rows.map((row) => [row.id, row.title]))
    },

    async findTransactionListingTitles(ids) {
      // 与 `findListingTitles` 同一套脏值收敛：`payload` 是自由 jsonb，形状不对就当没有。
      const valid = [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))]
      if (valid.length === 0) return new Map()
      const rows = await db
        .select({ id: transactions.id, title: listings.title })
        .from(transactions)
        // `transactions.listing_id` 的复合外键指向 `listings (id, seller_id)`，join 一定命中。
        .innerJoin(listings, eq(listings.id, transactions.listingId))
        .where(inArray(transactions.id, valid))
      return new Map(rows.map((row) => [row.id, row.title]))
    },

    async listChatSources({ since, unreadBefore, throttleSince, limit }) {
      // 收件人 = 会话里的**另一方**（会话严格双人，买家/卖家二选一）。
      const recipientId = sql<string>`case when ${messages.senderId} = ${conversations.buyerId} then ${conversations.sellerId} else ${conversations.buyerId} end`
      // 收件人一侧的读位；NULL = 从未读过（该会话的全部消息都算未读）。
      const recipientReadAt = sql<Date | null>`case when ${messages.senderId} = ${conversations.buyerId} then ${conversations.sellerLastReadAt} else ${conversations.buyerLastReadAt} end`

      const alreadyRegistered = notExists(
        db
          .select({ one: sql`1` })
          .from(subscribeMessageDeliveries)
          .where(
            and(
              eq(subscribeMessageDeliveries.sourceType, 'CHAT'),
              eq(subscribeMessageDeliveries.sourceId, messages.id),
              eq(subscribeMessageDeliveries.recipientId, recipientId),
            ),
          ),
      )

      // 30 分钟限频：该「会话 × 收件人」在窗口内已经有 CHAT 投递行（任何状态）。
      // 「已经推过一条」与「30 分钟内不再推」是同一件事，所以失败/跳过的行也占窗口。
      const throttled = notExists(
        db
          .select({ one: sql`1` })
          .from(subscribeMessageDeliveries)
          .where(
            and(
              eq(subscribeMessageDeliveries.sourceType, 'CHAT'),
              eq(subscribeMessageDeliveries.conversationId, conversations.id),
              eq(subscribeMessageDeliveries.recipientId, recipientId),
              gt(subscribeMessageDeliveries.createdAt, throttleSince),
            ),
          ),
      )

      // `distinct on` 让每「会话 × 收件人」只出一条候选（同组内取最新那条消息）：
      // 限频的维度就是它，靠唯一键是拦不住的 —— 同会话两条未读消息的 `source_id` 不同，
      // 一轮里会各插一行、各推一条（#511 审查 high）。
      const rows = await db
        .selectDistinctOn([conversations.id, recipientId], {
          messageId: messages.id,
          conversationId: messages.conversationId,
          recipientId,
          senderNickname: users.nickname,
          listingTitle: listings.title,
          messageCreatedAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        // 发送人必须是真人；SYSTEM 消息（交易提案/接受等）由 TX 通知那条路径负责，
        // 这里再推一条「对方发来新消息」是重复打扰。
        .innerJoin(users, eq(users.id, messages.senderId))
        .leftJoin(listings, eq(listings.id, conversations.listingId))
        .where(
          and(
            // `ne` 对 NULL 求值为 NULL（不成立）：SYSTEM 消息因此已被排除，不需要额外判空。
            ne(messages.senderId, recipientId),
            isNull(messages.recalledAt),
            gt(messages.createdAt, since),
            lte(messages.createdAt, unreadBefore),
            or(isNull(recipientReadAt), gt(messages.createdAt, recipientReadAt)),
            alreadyRegistered,
            throttled,
          ),
        )
        // `distinct on` 要求 ORDER BY 以同样的表达式开头；第三项决定组内留哪一条。
        .orderBy(conversations.id, recipientId, desc(messages.createdAt))
        .limit(limit)

      return rows
    },

    async listPendingDeliveryIds(now, limit) {
      const rows = await db
        .select({ id: subscribeMessageDeliveries.id })
        .from(subscribeMessageDeliveries)
        .where(
          and(
            eq(subscribeMessageDeliveries.status, 'PENDING'),
            lte(subscribeMessageDeliveries.nextAttemptAt, now),
          ),
        )
        .orderBy(subscribeMessageDeliveries.nextAttemptAt)
        .limit(limit)
      return rows.map((row) => row.id)
    },

    async attemptDelivery(deliveryId, now, send) {
      // ① 占位（**短事务，先提交**）：占行 → 校验到点 → 预扣额度 → 置 SENDING。
      //    这一次提交是"我已经决定发这条"的持久证据：之后无论怎么死，重启看到的都是
      //    SENDING（而不是回到 PENDING 再发一遍）。
      const claim = await db.transaction(async (tx) => {
        // `SKIP LOCKED` 让两个并发 tick 各自拿到不同的行，而不是排队等同一行。
        const locked = await tx
          .select({
            id: subscribeMessageDeliveries.id,
            recipientId: subscribeMessageDeliveries.recipientId,
            kind: subscribeMessageDeliveries.kind,
            data: subscribeMessageDeliveries.data,
            page: subscribeMessageDeliveries.page,
            attempts: subscribeMessageDeliveries.attempts,
            nextAttemptAt: subscribeMessageDeliveries.nextAttemptAt,
          })
          .from(subscribeMessageDeliveries)
          .where(
            and(
              eq(subscribeMessageDeliveries.id, deliveryId),
              eq(subscribeMessageDeliveries.status, 'PENDING'),
            ),
          )
          .for('update', { skipLocked: true })
        const delivery = locked[0]
        if (!delivery) return { outcome: 'gone' as const }
        // 列表查询之后可能已经过了一轮退避：真正的到点判据在这里（占住之后再判，避免 TOCTOU）。
        if (delivery.nextAttemptAt.getTime() > now.getTime()) return { outcome: 'not-due' as const }

        // 额度在占位这一事务里**预扣**（`remaining > 0` 由 WHERE 守，一条 UPDATE 同时判与扣）：
        // 跨事务之后不能再靠行锁把「同一人同一 kind」串起来，扣减本身必须原子。
        const reserved = await tx
          .update(subscribeMessageGrants)
          .set({
            remaining: sql`${subscribeMessageGrants.remaining} - 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(subscribeMessageGrants.userId, delivery.recipientId),
              eq(subscribeMessageGrants.kind, delivery.kind),
              gt(subscribeMessageGrants.remaining, 0),
            ),
          )
          .returning({ remaining: subscribeMessageGrants.remaining })
        if (reserved.length === 0) {
          await markSkipped(tx, deliveryId, now, 'no_quota')
          return { outcome: 'skipped' as const }
        }

        await tx
          .update(subscribeMessageDeliveries)
          .set({
            status: 'SENDING',
            attempts: sql`${subscribeMessageDeliveries.attempts} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(subscribeMessageDeliveries.id, deliveryId))

        return { outcome: 'claimed' as const, delivery }
      })

      if (claim.outcome !== 'claimed') return claim
      const { delivery } = claim
      const committedAttempts = delivery.attempts + 1

      // ② 发送：**不持事务**（见接口注释）。这里唯一一次上游调用，失败已经归成 `ok: false`。
      let signal: AttemptSignal
      try {
        signal = await send({
          id: delivery.id,
          recipientId: delivery.recipientId,
          kind: delivery.kind,
          data: delivery.data,
          page: delivery.page,
          attempts: delivery.attempts,
        })
      } catch {
        // `send` 的注入实现会查一次 openid（本地 SQL）：它抖一下就抛。归成可重试，
        // 别把行永远留在 SENDING 里等清扫。
        signal = { ok: false, reason: 'retryable', detail: 'internal-error' }
      }

      const transition = planAttempt(signal, committedAttempts)

      // ③ 落状态（短事务）：真正发出去了才留下那一次预扣，其余一律退回。
      return db.transaction(async (tx) => {
        if (transition.status === 'SENT') {
          await tx
            .update(subscribeMessageDeliveries)
            .set({
              status: 'SENT',
              sentAt: now,
              lastErrcode: null,
              lastError: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(subscribeMessageDeliveries.id, deliveryId))
          return { outcome: 'sent' as const }
        }

        if (transition.status === 'SKIPPED') {
          // 43101：本地计数与上游已经对不上，直接清零（清零本身就吸收了这次预扣）。
          if (transition.clearGrant) await zeroGrant(tx, delivery.recipientId, delivery.kind)
          else await refundGrant(tx, delivery.recipientId, delivery.kind)
          await markSkipped(
            tx,
            deliveryId,
            now,
            transition.error,
            committedAttempts,
            transition.errcode,
          )
          return { outcome: 'skipped' as const }
        }

        // 没发出去（参数错误 / 待重试）：把预扣退回，额度只按"真正发出的条数"减少。
        await refundGrant(tx, delivery.recipientId, delivery.kind)

        const status: SubscribeMessageDeliveryStatus =
          transition.status === 'RETRY' ? 'PENDING' : 'FAILED'
        const nextAttemptAt =
          transition.status === 'RETRY'
            ? new Date(now.getTime() + transition.nextAttemptInMs)
            : // 终态不再重试：`next_attempt_at` 留 `now`，部分索引按 status 过滤，不会误取。
              now
        await tx
          .update(subscribeMessageDeliveries)
          .set({
            status,
            lastErrcode: transition.errcode,
            lastError: transition.error,
            nextAttemptAt,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(subscribeMessageDeliveries.id, deliveryId))
        return { outcome: transition.status === 'RETRY' ? ('retry' as const) : ('failed' as const) }
      })
    },

    async abandonStaleSending(now, staleBefore) {
      // 「发送中」超时 = 发这条的进程在飞行途中死了，微信到底收没收到**不确定**。
      // 保守取「不重发」：标 FAILED（`interrupted`），替用户把重复提醒的风险降到 0。
      // 预扣的额度**不退**：不确定是否已经用掉一次时宁可少发一条，也不超发一条
      // （真超发了微信也会回 43101，本地计数随即清零，账目自愈）。
      const rows = await db
        .update(subscribeMessageDeliveries)
        .set({
          status: 'FAILED',
          lastErrcode: null,
          lastError: SENDING_INTERRUPTED_ERROR,
          nextAttemptAt: now,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(subscribeMessageDeliveries.status, 'SENDING'),
            lte(subscribeMessageDeliveries.updatedAt, staleBefore),
          ),
        )
        .returning({ id: subscribeMessageDeliveries.id })
      return rows.length
    },

    async findOpenid(userId) {
      const rows = await db
        .select({ openid: wechatIdentities.openid })
        .from(wechatIdentities)
        .where(eq(wechatIdentities.userId, userId))
        .limit(1)
      return rows[0]?.openid ?? null
    },
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * 「会话 × 收件人」限频组的键（只在内存里比较，不落库）。
 *
 * 两个 UUID 里都不可能出现冒号，`${conversation}:${recipient}` 拼接不会撞。
 */
function chatGroupKey(row: NewSubscribeDelivery): string {
  return `${row.conversationId}:${row.recipientId}`
}

/** `db` 与事务都能接的插入器（两者生成同一条 SQL）。 */
type DeliveryInserter = Pick<Tx, 'insert'>

/**
 * 批量插入投递行，返回真正插入的行数。
 *
 * 去重键冲突 = 这个来源已经为该收件人登记过，静默跳过（不更新任何列：先发生的那条
 * 已经带着当时的渲染结果，重扫不该覆盖它）。
 */
async function insertDeliveryRows(
  executor: DeliveryInserter,
  rows: NewSubscribeDelivery[],
): Promise<number> {
  if (rows.length === 0) return 0
  const inserted = await executor
    .insert(subscribeMessageDeliveries)
    .values(
      rows.map((row) => ({
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        recipientId: row.recipientId,
        kind: row.kind,
        // `jsonParam` 不能省：裸对象在 drizzle + bun-sql 下会被 stringify 两次，
        // 落库成 `jsonb_typeof = 'string'`（见 packages/db/src/json.ts）。
        data: jsonParam(row.data),
        page: row.page,
        conversationId: row.conversationId ?? null,
      })),
    )
    .onConflictDoNothing({
      target: [
        subscribeMessageDeliveries.sourceType,
        subscribeMessageDeliveries.sourceId,
        subscribeMessageDeliveries.recipientId,
      ],
    })
    .returning({ id: subscribeMessageDeliveries.id })
  return inserted.length
}

async function markSkipped(
  tx: Tx,
  deliveryId: string,
  now: Date,
  error: string,
  attempts?: number,
  errcode?: number,
): Promise<void> {
  await tx
    .update(subscribeMessageDeliveries)
    .set({
      status: 'SKIPPED',
      lastErrcode: errcode ?? null,
      lastError: error,
      nextAttemptAt: now,
      // 没走到发送就跳过的（额度为 0）不增加尝试次数：那不是一次尝试。
      ...(attempts === undefined ? {} : { attempts }),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(subscribeMessageDeliveries.id, deliveryId))
}

async function zeroGrant(tx: Tx, userId: string, kind: SubscribeMessageKind): Promise<void> {
  await tx
    .update(subscribeMessageGrants)
    .set({ remaining: 0, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(subscribeMessageGrants.userId, userId), eq(subscribeMessageGrants.kind, kind)))
}

/**
 * 退回一次**预扣**（没发出去的那次）。
 *
 * 正常情况下这 1 就是占位事务里扣掉的那 1，退回后回到 ≤ 上限的原值。仍写 `least(limit, …)`：
 * 占位与退回落在了两个事务里，中间用户可能又授权几次把计数顶到上限，裸 `+1` 会撞上
 * `remaining <= 50` 的 CHECK（那会让整个落状态事务回滚、行卡在 SENDING）。
 */
async function refundGrant(tx: Tx, userId: string, kind: SubscribeMessageKind): Promise<void> {
  await tx
    .update(subscribeMessageGrants)
    .set({
      remaining: sql`least(${SUBSCRIBE_MESSAGE_GRANT_LIMIT}, ${subscribeMessageGrants.remaining} + 1)`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(subscribeMessageGrants.userId, userId), eq(subscribeMessageGrants.kind, kind)))
}
