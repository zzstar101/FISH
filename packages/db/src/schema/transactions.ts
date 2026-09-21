import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { listings } from './listings'
import { users } from './users'

export const transactionStatusEnum = pgEnum('transaction_status', [
  'PENDING_MEETUP',
  'COMPLETED',
  'CANCELLED',
])

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 交易（#11）。行在接受交易时才创建，即 `PENDING_MEETUP` = 已被卖家接受、待面交；
 * "买家发起确认"这一步不落库，由 #9 的 SYSTEM 消息承载。
 *
 * 并发不变量靠两件事共同保证：
 * 1. 接受时用条件更新 `UPDATE listings SET status='RESERVED' WHERE id = ? AND status='ACTIVE'`；
 * 2. 下面的部分唯一索引兜底，保证一个 listing 最多一笔"进行中或已成交"的交易。
 */
export const transactions = pgTable(
  'transactions',
  {
    ...primaryKey(),
    /** 成交记录不可连坐删除，故不用 CASCADE。 */
    listingId: uuid('listing_id').notNull(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    /** 由下面的复合外键保证与商品所有者一致。 */
    sellerId: uuid('seller_id').notNull(),
    /** 议价结果；不等于 listings.price_cents。 */
    amountCents: integer('amount_cents').notNull(),
    status: transactionStatusEnum('status').notNull().default('PENDING_MEETUP'),
    /** #11 的"双方确认完成"：两侧各存一份，只点了一边时交易仍停在 PENDING_MEETUP。 */
    buyerConfirmedAt: timestamptz('buyer_confirmed_at'),
    sellerConfirmedAt: timestamptz('seller_confirmed_at'),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    ...timestamps(),
  },
  (table) => [
    // 复合外键：seller_id 必须等于该商品的 seller_id，而不只是"是个存在的用户"
    foreignKey({
      columns: [table.listingId, table.sellerId],
      foreignColumns: [listings.id, listings.sellerId],
      name: 'transactions_listing_id_seller_id_fk',
    }),
    uniqueIndex('transactions_listing_id_live_uq')
      .on(table.listingId)
      .where(sql`${table.status} IN ('PENDING_MEETUP', 'COMPLETED')`),
    check('transactions_amount_cents_non_negative', sql`${table.amountCents} >= 0`),
    check(
      'transactions_buyer_id_differs_from_seller_id',
      sql`${table.buyerId} <> ${table.sellerId}`,
    ),
    check(
      // NULL-safe：status 是 NOT NULL，`IS NOT NULL` 永不返回 NULL，
      // 因此两个非空 boolean 的相等判定不可能为 NULL（已用 psql 实测：
      // COMPLETED 缺 completed_at / CANCELLED 缺 cancelled_at 均被拒绝）。
      'transactions_completed_at_matches_status',
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      'transactions_cancelled_at_matches_status',
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL)`,
    ),
  ],
)

/**
 * 面交交易码（#70，#147 改为长期凭证）。一行对应一笔交易的**当前**凭证：重新签发
 * （刷新）即整行覆写，旧码立即作废 —— 「一次性」由 consumed_at 承载；有效期即
 * PENDING_MEETUP 的生命周期，交易进终态（COMPLETED / CANCELLED）时同事务删行。
 *
 * 安全口径：**不存明文**。6 位码与 QR token 都只存 HMAC-SHA256（服务端密钥见
 * `MEETUP_TOKEN_SECRET`），明文只在签发响应里出现一次；6 位码空间只有 10^6，
 * 连续失败由 failed_attempts / locked_until 限流（服务层负责）。
 *
 * 状态不落列：NONE（无行）/ ISSUED / CONSUMED（consumed_at 非空）全部可派生，
 * 避免派生值与真实时间漂移。
 */
export const transactionMeetupTokens = pgTable(
  'transaction_meetup_tokens',
  {
    /** 一笔交易至多一个当前凭证（PK 即外键，与 transactions 一对一）。 */
    transactionId: uuid('transaction_id')
      .primaryKey()
      .references(() => transactions.id),
    /** QR token 的 HMAC-SHA256（hex）。token 本身 16 字节随机，只出现在签发响应。 */
    tokenHash: text('token_hash').notNull(),
    /** 6 位面交码的 HMAC-SHA256（hex）。 */
    codeHash: text('code_hash').notNull(),
    /** 签发人 = 交易卖家（服务层校验角色，这里只保证是个真实用户）。 */
    issuedBy: uuid('issued_by')
      .notNull()
      .references(() => users.id),
    issuedAt: timestamptz('issued_at').notNull().defaultNow(),
    /** 消费即核销：置非空后任何再次核销都被拒（一次性）。 */
    consumedAt: timestamptz('consumed_at'),
    consumedBy: uuid('consumed_by').references(() => users.id),
    /** 核销失败累计（QR token / 6 位码共用的防爆破计数）；行被消费后计数不再有意义，
     * 重新签发（覆写）时归零。 */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    /** 连续失败达阈值后的禁用期；期间核销一律 429。 */
    lockedUntil: timestamptz('locked_until'),
  },
  (table) => [
    // 与 transactions 表同款完整性 CHECK：consumed_at 与 consumed_by 必须同生同灭。
    check(
      'transaction_meetup_tokens_consumed_by_matches_consumed_at',
      sql`(${table.consumedAt} IS NULL) = (${table.consumedBy} IS NULL)`,
    ),
  ],
)
