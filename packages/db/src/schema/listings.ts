import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, primaryKey, timestamps } from './common'
import { users } from './users'

/** 分类值集由 #2 冻结；#8 的匹配按分类等值打分，需要稳定值域。 */
export const listingCategoryEnum = pgEnum('listing_category', [
  'DIGITAL',
  'BOOKS',
  'BEAUTY',
  'DAILY',
  'SPORTS',
  'APPAREL',
  'TRANSPORT',
  'OTHER',
])

export const listingConditionEnum = pgEnum('listing_condition', ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'])

export const listingStatusEnum = pgEnum('listing_status', ['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'])

export const listings = pgTable(
  'listings',
  {
    ...primaryKey(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** 金额统一整数分。 */
    priceCents: integer('price_cents').notNull(),
    category: listingCategoryEnum('category').notNull(),
    condition: listingConditionEnum('condition').notNull(),
    status: listingStatusEnum('status').notNull().default('ACTIVE'),
    /** #6 的 P0 工作项；#14 只消费这三列做标签与加权。 */
    urgent: boolean('urgent').notNull().default(false),
    negotiable: boolean('negotiable').notNull().default(false),
    free: boolean('free').notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    check('listings_price_cents_non_negative', sql`${table.priceCents} >= 0`),
    // 复合外键目标：让 conversations / transactions 能在 DB 层断言"卖家 = 商品所有者"。
    // 必须是表级 UNIQUE 约束而非 uniqueIndex —— drizzle-kit 把唯一索引排在
    // `ALTER TABLE ... ADD CONSTRAINT FK` 之后，PG 会在建外键时报
    // "there is no unique constraint matching given keys"。
    unique('listings_id_seller_id_uq').on(table.id, table.sellerId),
    index('listings_status_created_at_idx').on(table.status, table.createdAt),
    index('listings_category_price_cents_idx').on(table.category, table.priceCents),
    index('listings_seller_id_status_idx').on(table.sellerId, table.status),
  ],
)

/**
 * 图片只存 object key，URL 由 `S3_PUBLIC_URL + '/' + object_key` 在读时拼。
 * 封面 = `sort_order = 0`；1–9 张由 #6 的 service 校验（跨行计数用约束表达不了）。
 */
export const listingImages = pgTable(
  'listing_images',
  {
    ...primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('listing_images_listing_id_sort_order_uq').on(table.listingId, table.sortOrder),
    check('listing_images_sort_order_non_negative', sql`${table.sortOrder} >= 0`),
  ],
)
