import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
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
