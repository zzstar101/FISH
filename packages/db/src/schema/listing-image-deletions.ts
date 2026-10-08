import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { createdAt } from './common'

/**
 * 被替换掉的公开商品图对象的**待删台账**（#476）。
 *
 * 背景：图片写路径是**全量替换**（`apps/api/src/modules/listings/store.ts` 的
 * `updateListingAtomic` 先删后插 `listing_images`），旧 `listings/…` 对象从图片组里摘除后
 * 本体留在对象存储：无人引用、无 TTL、无回收，桶里对象数随换图次数单调增长。
 *
 * 一行 = 「某个公开图片键已从商品图片组里摘除，等待回收」。写入方是 listings 写路径的
 * **同一个事务**（换图与登记原子）：`removed_at` = 该键最后一次被引用的时刻（即被摘除的时刻）；
 * 回收方是 worker 的 `jobs/listing-image-cleanup`，按 `removed_at + 保留期` 到期、并确认
 * 没有任何 `listing_images` 再引用它之后才删对象。
 *
 * **只登记公开键**（`listings/…`）。审核中的图在私有前缀 `listing-review-media/…` 下（永不匿名可读），
 * 从不进这张表 —— 「并发评审中的图不得进入待删集合」因此是结构性的，而不是靠删除时的判断。
 *
 * `object_key` 直接做主键：一个键最多一行，登记用 `ON CONFLICT DO UPDATE` 刷新 `removed_at`。
 * 表里没有外键：键指向的是对象存储里的对象，与库内行没有引用关系（引用关系只能靠
 * 删除前对 `listing_images` 的复核来回答）。
 */
export const listingImageDeletions = pgTable(
  'listing_image_deletions',
  {
    objectKey: text('object_key').primaryKey(),
    /** 该键最后一次被引用的时刻（被摘除的时刻）。保留期从这个时刻起算。 */
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // 回收按 `removed_at` 升序取批，走这条索引。
    index('listing_image_deletions_removed_at_idx').on(table.removedAt),
    // 纵深防御：只有公开商品图键该出现在这里。私有/暂存前缀若被误登记，它会在回收时
    // 删掉不属于自己的对象，所以在写入这一层就挡住。
    check('listing_image_deletions_public_prefix', sql`${table.objectKey} LIKE 'listings/%'`),
  ],
)
