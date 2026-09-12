import { sql } from 'drizzle-orm'
import { check, integer, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
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
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
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
    uniqueIndex('transactions_listing_id_live_uq')
      .on(table.listingId)
      .where(sql`${table.status} IN ('PENDING_MEETUP', 'COMPLETED')`),
    check('transactions_amount_cents_non_negative', sql`${table.amountCents} >= 0`),
    check(
      'transactions_buyer_id_differs_from_seller_id',
      sql`${table.buyerId} <> ${table.sellerId}`,
    ),
    check(
      'transactions_completed_at_matches_status',
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      'transactions_cancelled_at_matches_status',
      sql`(${table.status} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL)`,
    ),
  ],
)
