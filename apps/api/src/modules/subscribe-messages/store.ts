import type { SubscribeMessageKind } from '@fish/contracts/subscribe-messages/schema'
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
import { users, wechatIdentities } from '@fish/db/schema/users'
import { and, eq, gt, inArray, isNull, lte, ne, notExists, or, sql } from 'drizzle-orm'
import { type AttemptSignal, planAttempt } from './outcome'

/**
 * 微信订阅消息的持久化层（#462）：授权记账 + 投递行。
 *
 * 两张表的分工见 `packages/db/src/schema/subscribe-messages.ts` 的注释；本文件只负责
 * 「怎么读写」，三条口径写在这里：
 *
 * 1. **登记一律 `ON CONFLICT DO NOTHING`**，不先查后写。去重键是
 *    `(source_type, source_id, recipient_id)`，它同时是"重启后重扫"与"两个 tick 交错"的
 *    防线 —— 先查后写在两个并发 tick 之间仍然会各插一行。
 * 2. **一条投递行的扣额度、发送、落状态在同一个事务里**（`attemptDelivery`）：额度扣减
 *    与状态更新要么一起生效、要么一起回滚，并且用 `FOR UPDATE SKIP LOCKED` 占行，
 *    所以同一个 tick 不会把同一条发两遍、两个 tick 也不会。
 * 3. **额度行也加锁**（`FOR UPDATE`）：同一个人同一 kind 的并发发送被串行化，否则
 *    "先读 remaining=1 再各发一条"会突破授权次数。
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
   * 「对方发来的、收件人还没读」的消息（CHAT 投递的来源）。
   *
   * 四条判据都在 SQL 里，因为它们各自都要走索引（见 schema 的三个索引）：
   * - `unreadBefore` 之前：消息至少 60 秒了还没被读，才值得推（刚发出的不打扰）；
   * - 收件人一侧的 `last_read_at` 为空或早于消息：未读；
   * - 该消息还没为该收件人登记过（`source_type='CHAT'` + `source_id`）；
   * - `throttleSince` 之后该「会话 × 收件人」没有任何 CHAT 投递（30 分钟限频）。
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
   * 占住一条投递行 → 校验额度 → 发送 → 落状态，**全部在一个事务里**。
   *
   * `send` 只做「调微信」这一件事（它拿到的 `LockedDelivery` 已含渲染好的 `data` / `page`）；
   * 决策全部由 `outcome.ts` 的 `planAttempt` 给，本方法只照抄。
   */
  attemptDelivery(
    deliveryId: string,
    now: Date,
    send: (delivery: LockedDelivery) => Promise<AttemptSignal>,
  ): Promise<AttemptOutcome>

  /** 收件人的微信 openid；没有微信身份为 `null`。 */
  findOpenid(userId: string): Promise<string | null>
}

/** 登记 `notifications` 时关心的四类（`MATCH` 不在首批，SQL 里就排掉，不搬运）。 */
const NOTIFICATION_SOURCE_TYPES: NotificationType[] = ['TX', 'DISPUTE', 'MODERATION', 'ACCOUNT']

/** UUID 形状（`payload` 里的 id 是裸 UUID，但 jsonb 是自由字段：脏值一律当没有）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
      if (rows.length === 0) return 0
      const inserted = await db
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
        // 去重键冲突 = 这个来源已经为该收件人登记过，静默跳过（不更新任何列：
        // 先发生的那条已经带着当时的渲染结果，重扫不该覆盖它）。
        .onConflictDoNothing({
          target: [
            subscribeMessageDeliveries.sourceType,
            subscribeMessageDeliveries.sourceId,
            subscribeMessageDeliveries.recipientId,
          ],
        })
        .returning({ id: subscribeMessageDeliveries.id })
      return inserted.length
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

      const rows = await db
        .select({
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
        .orderBy(messages.createdAt)
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
      return db.transaction(async (tx) => {
        // ① 占行：`SKIP LOCKED` 让两个并发 tick 各自拿到不同的行，而不是排队等同一行。
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
        if (!delivery) return { outcome: 'gone' }
        // 列表查询之后可能已经过了一轮退避：真正的到点判据在这里（占住之后再判，避免 TOCTOU）。
        if (delivery.nextAttemptAt.getTime() > now.getTime()) return { outcome: 'not-due' }

        // ② 额度行加锁（同一人同一 kind 的发送串行化），额度为 0 就不发。
        const grantRows = await tx
          .select({ remaining: subscribeMessageGrants.remaining })
          .from(subscribeMessageGrants)
          .where(
            and(
              eq(subscribeMessageGrants.userId, delivery.recipientId),
              eq(subscribeMessageGrants.kind, delivery.kind),
            ),
          )
          .for('update')
        if ((grantRows[0]?.remaining ?? 0) <= 0) {
          await markSkipped(tx, deliveryId, now, 'no_quota')
          return { outcome: 'skipped' }
        }

        // ③ 发送（唯一一次上游调用；失败已经归成 `ok: false`，不会抛）。
        const outcome = await send({
          id: delivery.id,
          recipientId: delivery.recipientId,
          kind: delivery.kind,
          data: delivery.data,
          page: delivery.page,
          attempts: delivery.attempts,
        })

        const committedAttempts = delivery.attempts + 1
        const transition = planAttempt(outcome, committedAttempts)

        if (transition.status === 'SENT') {
          await tx
            .update(subscribeMessageGrants)
            .set({
              remaining: sql`${subscribeMessageGrants.remaining} - 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(subscribeMessageGrants.userId, delivery.recipientId),
                eq(subscribeMessageGrants.kind, delivery.kind),
              ),
            )
          await tx
            .update(subscribeMessageDeliveries)
            .set({
              status: 'SENT',
              attempts: committedAttempts,
              sentAt: now,
              lastErrcode: null,
              lastError: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(subscribeMessageDeliveries.id, deliveryId))
          return { outcome: 'sent' }
        }

        if (transition.status === 'SKIPPED') {
          if (transition.clearGrant) await zeroGrant(tx, delivery.recipientId, delivery.kind)
          await markSkipped(
            tx,
            deliveryId,
            now,
            transition.error,
            committedAttempts,
            transition.errcode,
          )
          return { outcome: 'skipped' }
        }

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
            attempts: committedAttempts,
            lastErrcode: transition.errcode,
            lastError: transition.error,
            nextAttemptAt,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(subscribeMessageDeliveries.id, deliveryId))
        return { outcome: transition.status === 'RETRY' ? 'retry' : 'failed' }
      })
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
