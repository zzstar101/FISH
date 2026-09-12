import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { listings } from './listings'
import { users } from './users'

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 商品维度的双人会话（#9）。未读状态直接落两列：会话严格是买方 + 卖方两人，
 * #9 明确不做群聊，因此不建 conversation_participants 表。
 */
export const conversations = pgTable(
  'conversations',
  {
    ...primaryKey(),
    /** 业务记录，不用 CASCADE：会话是用户产生的数据，不因商品行消失而被连坐清除。 */
    listingId: uuid('listing_id').notNull(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    /** 反范式：数据来自 listings.seller_id；由下面的复合外键保证与商品所有者一致。 */
    sellerId: uuid('seller_id').notNull(),
    buyerLastReadAt: timestamptz('buyer_last_read_at'),
    sellerLastReadAt: timestamptz('seller_last_read_at'),
    /** 创建时即为 created_at，因此非空——避免 ORDER BY ... DESC 把新会话排到 NULLS FIRST。 */
    lastMessageAt: timestamptz('last_message_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    // 复合外键：seller_id 必须等于该商品的 seller_id，而不只是"是个存在的用户"
    foreignKey({
      columns: [table.listingId, table.sellerId],
      foreignColumns: [listings.id, listings.sellerId],
      name: 'conversations_listing_id_seller_id_fk',
    }),
    // seller 由 listing 决定，因此 (listing_id, buyer_id) 就是 #9 的"买家+卖家+商品"复用键
    uniqueIndex('conversations_listing_id_buyer_id_uq').on(table.listingId, table.buyerId),
    index('conversations_buyer_id_last_message_at_idx').on(table.buyerId, table.lastMessageAt),
    index('conversations_seller_id_last_message_at_idx').on(table.sellerId, table.lastMessageAt),
    check(
      'conversations_buyer_id_differs_from_seller_id',
      sql`${table.buyerId} <> ${table.sellerId}`,
    ),
  ],
)
