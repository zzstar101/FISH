import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { listings } from './listings'

/** 平台绝对租期界（Epic #704 M0 冻结：1–90 天，Asia/Shanghai 自然日）。 */
export const RENTAL_MIN_DAYS = 1
export const RENTAL_MAX_DAYS = 90

/**
 * 出租条款（#706 RNT-02）：**与 RENTAL Listing 一对一**的可预约参数。
 *
 * ## 为什么单独一张表而不是往 `listings` 加列
 *
 * 这些列只对 `listing_type = 'RENTAL'` 有意义，放进 `listings` 会让 40% 的列对出售商品恒为
 * NULL（`deposit_cents` / `min_days` / `max_days` / `terms_version` …），并且所有既有 SALE 查询
 * 都要带着一串「这列对我不适用」的噪声。独立表 + `ON DELETE CASCADE` 保持 `listings` 干净，
 * 「出租一定有条款」由 `listing_id` 唯一约束 + 同事务创建保证（见 `createRentalListingAtomic`）。
 *
 * ## `terms_version` 是条款快照的版本号
 *
 * 日租价 / 押金 / 规则文字任一变化都 `version + 1`。预约单在创建时持久化当时的条款快照
 * （#707），接单时比对版本：不一致就 409 `RENTAL_TERMS_CHANGED`，端上展示差异。
 * 版本只增不减；**不可回退到旧版本**（没有「撤销修改」这条路径，否则已发的重确认会歧义）。
 *
 * ## 有履约中订单时的编辑边界
 *
 * 「限制有害编辑」在服务层实现（`service.ts` 的 `assertNoLiveOrdersForTerms`）：
 * 存在 `ACCEPTED` / `IN_USE` 的订单时，**日租价与押金不可改**（规则文字仍可改，因为它不进金额
 * 快照）。判据必须查租赁订单表（#707 引入），本单先留接口位。
 */
export const rentalTerms = pgTable(
  'rental_terms',
  {
    ...primaryKey(),
    /**
     * 一对一：一个 Listing 至多一行条款。`ON DELETE CASCADE` 让物理删除商品（#74 的
     * `deleteListingAtomic`）连带清掉条款 —— 出租商品的删除归租赁域，但底层仍是同一条
     * `listings` 行，级联方向必须与 `listing_images` 一致。
     */
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** 约定押金（整数分）。与日租价同口径：**平台只记录，不代收**（见 RENTAL_DEPOSIT_NOTICE）。 */
    depositCents: integer('deposit_cents').notNull(),
    /**
     * 出租规则（文字）。允许为空 = 商家没写额外规则。
     * 长度上限由契约（`RENTAL_RULES_MAX`）收口，DB 是裸 `text`（与 `listings.title` 同口径）。
     */
    rules: text('rules'),
    /** 商家自定的最短租期（自然日）。必须落在平台绝对界内。 */
    minDays: integer('min_days').notNull(),
    /** 商家自定的最长租期（自然日）。必须 ≥ `min_days` 且 ≤ 平台上限。 */
    maxDays: integer('max_days').notNull(),
    /**
     * 条款版本（从 1 起）。日租价 / 押金 / 规则任一变化都 +1；预约单据此判断「条款变过」。
     */
    termsVersion: integer('terms_version').notNull().default(1),
    ...timestamps(),
  },
  (table) => [
    unique('rental_terms_listing_id_uq').on(table.listingId),
    // 平台绝对界在 DB 兜底：service 会按「合并后的最终状态」校验（与 free⟹price 同一手法），
    // 但约束对所有写入方生效 —— 将来任何绕过 service 的写路径也造不出 0 天或 500 天的租期。
    check(
      'rental_terms_min_days_range',
      sql`${table.minDays} >= ${sql.raw(String(RENTAL_MIN_DAYS))} AND ${table.minDays} <= ${sql.raw(String(RENTAL_MAX_DAYS))}`,
    ),
    check(
      'rental_terms_max_days_range',
      sql`${table.maxDays} >= ${table.minDays} AND ${table.maxDays} <= ${sql.raw(String(RENTAL_MAX_DAYS))}`,
    ),
    check('rental_terms_deposit_non_negative', sql`${table.depositCents} >= 0`),
    check('rental_terms_version_positive', sql`${table.termsVersion} >= 1`),
    // 规则文字的长度上限在契约里（2000 字），DB 只挡「明显异常的超长行」以免存储被滥用。
    check(
      'rental_terms_rules_length',
      sql`${table.rules} IS NULL OR char_length(${table.rules}) <= 2000`,
    ),
    // 出租 Feed 的公开查询按 (min_days, max_days) 过滤可用租期区间；先建一条便于后续统计。
    index('rental_terms_max_days_idx').on(table.maxDays),
  ],
)

export type RentalTermsRow = typeof rentalTerms.$inferSelect
export type RentalTermsInsert = typeof rentalTerms.$inferInsert
