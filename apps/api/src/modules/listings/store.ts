import type {
  ListingCategory,
  ListingCondition,
  ListingStatus,
} from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'

export type ListingRow = typeof listings.$inferSelect
export type ListingImageRow = typeof listingImages.$inferSelect
export type SellerRow = typeof users.$inferSelect

/**
 * 游标在 store 层是**已解码且与排序键类型匹配**的结构：类型由 service 按 sort 校验后
 * 才走到这里，SQL 层不再做"宽容解析"（契约 §2.1：非法 cursor 报 422）。
 */
export type FeedCursorKey =
  /** `createdAt` 是**数据库精度（微秒）**的文本，不是 JS Date —— 见 cursor.ts 的说明。 */
  | { kind: 'newest'; createdAt: string; id: string }
  | { kind: 'priceAsc'; priceCents: number; id: string }
  | { kind: 'priceDesc'; priceCents: number; id: string }

export type FeedCriteria = {
  limit: number
  cursor: FeedCursorKey | null
  sort: 'newest' | 'priceAsc' | 'priceDesc'
  status: ListingStatus
  search?: string | undefined
  category?: ListingCategory | undefined
  priceMinCents?: number | undefined
  priceMaxCents?: number | undefined
  sellerId?: string | undefined
}

export type FeedEntry = {
  listing: ListingRow
  /**
   * 供游标使用的、**微秒精度**的 `created_at` 文本。
   * 单独取一份而不是由 `listing.createdAt.toISOString()` 推导：后者只有毫秒，
   * 会让同一毫秒内的行在翻页时被跳过。
   */
  createdAtCursor: string
  coverObjectKey: string | null
}

export type CreateListingRecord = {
  id: string
  sellerId: string
  title: string
  description: string
  priceCents: number
  category: ListingCategory
  condition: ListingCondition
  urgent: boolean
  negotiable: boolean
  free: boolean
  objectKeys: string[]
  /** 去重窗口起点：`now - 5s`（契约 §2.3）。 */
  duplicateWindowStart: Date
}

export type UpdateListingFields = {
  title?: string
  description?: string
  priceCents?: number
  category?: ListingCategory
  condition?: ListingCondition
  urgent?: boolean
  negotiable?: boolean
  free?: boolean
}

/** 编辑/下架/上架前需要的当前行状态（权限、状态机、free⟹price 的合并校验都要用）。 */
export type ListingState = {
  sellerId: string
  status: ListingStatus
  priceCents: number
  free: boolean
}

export interface ListingStore {
  /**
   * 事务内完成：按卖家串行化 → 5 秒内容窗口查重 → 写入商品 + 图片 + `MATCH_LISTING` job。
   *
   * job 与商品同事务是刻意的：#6 的验收要求"发布成功可靠写入 job"，分开两步就会出现
   * "商品已存在但永不匹配"的静默失败。
   */
  createListingAtomic(
    record: CreateListingRecord,
  ): Promise<{ kind: 'created' | 'duplicate'; listingId: string }>

  /** 命中重复窗口时重新投递（契约 §2.3）：前一次投递失败不能让该商品永久失配。 */
  enqueueMatchJob(listingId: string): Promise<void>

  findDetail(
    id: string,
  ): Promise<{ listing: ListingRow; seller: SellerRow; images: ListingImageRow[] } | null>

  findState(id: string): Promise<ListingState | null>

  listFeed(criteria: FeedCriteria): Promise<FeedEntry[]>

  updateListing(input: {
    id: string
    sellerId: string
    fields: UpdateListingFields
    /** 出现即**全量替换**图片（契约 §2.4）。 */
    objectKeys?: string[]
  }): Promise<ListingRow | null>

  /** 只从 `from` 迁到 `to`；返回是否真的改了行（并发下可能已被别人改走）。 */
  setStatus(input: { id: string; from: ListingStatus; to: ListingStatus }): Promise<boolean>
}

/** 新商品默认落 `ACTIVE`。 */
const NEW_LISTING_STATUS: ListingStatus = 'ACTIVE'

export function createSqlListingStore(db: Db): ListingStore {
  return {
    async createListingAtomic(record) {
      return db.transaction(async (tx) => {
        // 同一卖家的事务串行化：让"查重 → 插入"成为原子操作，并发的双击提交不会各插一行。
        // 与 #7 已合并的写法一致（apps/api/src/modules/wishes/store.ts 的 createOrGetRecent）。
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.sellerId}))`)

        const duplicate = await tx
          .select({ id: listings.id })
          .from(listings)
          .where(
            and(
              eq(listings.sellerId, record.sellerId),
              eq(listings.title, record.title),
              eq(listings.priceCents, record.priceCents),
              eq(listings.category, record.category),
              gt(listings.createdAt, record.duplicateWindowStart),
            ),
          )
          .orderBy(desc(listings.createdAt))
          .limit(1)

        const existing = duplicate[0]
        if (existing) return { kind: 'duplicate' as const, listingId: existing.id }

        await tx.insert(listings).values({
          id: record.id,
          sellerId: record.sellerId,
          title: record.title,
          description: record.description,
          priceCents: record.priceCents,
          category: record.category,
          condition: record.condition,
          status: NEW_LISTING_STATUS,
          urgent: record.urgent,
          negotiable: record.negotiable,
          free: record.free,
        })

        // 下标即 sortOrder（0 = 封面），与 #6 契约 §1 和 DB 的
        // listing_images_listing_id_sort_order_uq 唯一索引一致。
        await tx.insert(listingImages).values(
          record.objectKeys.map((objectKey, index) => ({
            listingId: record.id,
            objectKey,
            sortOrder: index,
          })),
        )

        await enqueueMatchJobWith(tx, record.id)

        return { kind: 'created' as const, listingId: record.id }
      })
    },

    async enqueueMatchJob(listingId) {
      await enqueueMatchJobWith(db, listingId)
    },

    async findDetail(id) {
      const rows = await db
        .select({ listing: listings, seller: users })
        .from(listings)
        .innerJoin(users, eq(users.id, listings.sellerId))
        .where(eq(listings.id, id))
        .limit(1)

      const row = rows[0]
      if (!row) return null

      const images = await db
        .select()
        .from(listingImages)
        .where(eq(listingImages.listingId, id))
        .orderBy(asc(listingImages.sortOrder))

      return { listing: row.listing, seller: row.seller, images }
    },

    async findState(id) {
      const rows = await db
        .select({
          sellerId: listings.sellerId,
          status: listings.status,
          priceCents: listings.priceCents,
          free: listings.free,
        })
        .from(listings)
        .where(eq(listings.id, id))
        .limit(1)

      return rows[0] ?? null
    },

    async listFeed(criteria) {
      const conditions: SQL[] = [eq(listings.status, criteria.status)]

      if (criteria.sellerId) conditions.push(eq(listings.sellerId, criteria.sellerId))
      if (criteria.category) conditions.push(eq(listings.category, criteria.category))
      if (criteria.priceMinCents !== undefined) {
        conditions.push(gte(listings.priceCents, criteria.priceMinCents))
      }
      if (criteria.priceMaxCents !== undefined) {
        conditions.push(lte(listings.priceCents, criteria.priceMaxCents))
      }
      if (criteria.search) {
        // 搜索范围 = title + description（契约 §2.1）；用 ILIKE 而非 FTS 是实现选择，
        // 契约只声明范围，不承诺匹配算法。
        const pattern = `%${criteria.search}%`
        const searchCondition = or(
          ilike(listings.title, pattern),
          ilike(listings.description, pattern),
        )
        if (searchCondition) conditions.push(searchCondition)
      }

      const cursorCondition = cursorSql(criteria)
      if (cursorCondition) conditions.push(cursorCondition)

      // 多取一行用于判断"还有没有下一页"，返回前丢掉（契约 §2.1：不另给 hasMore）。
      const rows = await db
        .select({
          listing: listings,
          createdAtCursor: sql<string>`to_char(${listings.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(listings)
        .where(and(...conditions))
        .orderBy(...orderBySql(criteria.sort))
        .limit(criteria.limit + 1)

      if (rows.length === 0) return []

      // 封面单独查一次而不是 join：一页最多 50 条、封面最多 50 张，
      // 比让每行都带出 9 张图的行放大便宜得多。
      const pageIds = rows.map((row) => row.listing.id)
      const covers = await db
        .select({ listingId: listingImages.listingId, objectKey: listingImages.objectKey })
        .from(listingImages)
        .where(and(inArray(listingImages.listingId, pageIds), eq(listingImages.sortOrder, 0)))

      const coverByListing = new Map(covers.map((cover) => [cover.listingId, cover.objectKey]))

      return rows.map((row) => ({
        listing: row.listing,
        createdAtCursor: row.createdAtCursor,
        coverObjectKey: coverByListing.get(row.listing.id) ?? null,
      }))
    },

    async updateListing(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(listings)
          .set({ ...input.fields, updatedAt: new Date() })
          .where(and(eq(listings.id, input.id), eq(listings.sellerId, input.sellerId)))
          .returning()

        const updated = rows[0]
        if (!updated) return null

        if (input.objectKeys) {
          // 全量替换：先删后插，同一事务内保证不会出现"新图未写入但旧图已删"的中间态。
          await tx.delete(listingImages).where(eq(listingImages.listingId, input.id))
          await tx.insert(listingImages).values(
            input.objectKeys.map((objectKey, index) => ({
              listingId: input.id,
              objectKey,
              sortOrder: index,
            })),
          )
        }

        return updated
      })
    },

    async setStatus(input) {
      const rows = await db
        .update(listings)
        .set({ status: input.to, updatedAt: new Date() })
        .where(and(eq(listings.id, input.id), eq(listings.status, input.from)))
        .returning({ id: listings.id })

      return rows.length > 0
    },
  }
}

function orderBySql(sort: FeedCriteria['sort']) {
  switch (sort) {
    case 'priceAsc':
      return [asc(listings.priceCents), desc(listings.id)]
    case 'priceDesc':
      return [desc(listings.priceCents), desc(listings.id)]
    default:
      return [desc(listings.createdAt), desc(listings.id)]
  }
}

/**
 * tie-break 全部用 `id DESC`，与 `orderBySql` 一一对应。
 * 少了 id 比较，同毫秒创建 / 同价格的商品会在翻页边界上重复或跳项。
 */
function cursorSql(criteria: FeedCriteria): SQL | undefined {
  const cursor = criteria.cursor
  if (!cursor) return undefined

  switch (cursor.kind) {
    case 'newest':
      // 用文本 + `::timestamptz` 而不是 JS Date：文本保留微秒，且比较仍然落在
      // `listings_status_created_at_idx` 上（date_trunc 会失去索引可用性）。
      return or(
        sql`${listings.createdAt} < ${cursor.createdAt}::timestamptz`,
        and(
          sql`${listings.createdAt} = ${cursor.createdAt}::timestamptz`,
          lt(listings.id, cursor.id),
        ),
      )
    case 'priceAsc':
      return or(
        gt(listings.priceCents, cursor.priceCents),
        and(eq(listings.priceCents, cursor.priceCents), lt(listings.id, cursor.id)),
      )
    case 'priceDesc':
      return or(
        lt(listings.priceCents, cursor.priceCents),
        and(eq(listings.priceCents, cursor.priceCents), lt(listings.id, cursor.id)),
      )
  }
}

/**
 * 写 `MATCH_LISTING` job。
 *
 * **必须用 `sql` 模板直接传对象，不能用 `insert().values({ payload: {...} })`**：
 * drizzle 0.45.2 + `bun-sql` 的 jsonb 参数映射会把对象 stringify 两次，落库成为
 * 「JSON 字符串套 JSON」（`jsonb_typeof = 'string'`）。那样的行用 drizzle 读回来是正常的，
 * 但 `payload->>'listingId'` 在 SQL 层恒为 NULL —— #8 的 worker 只要用 SQL 取 payload
 * 就永远匹配不到，而这是最自然的写法。
 *
 * 对照实测（同一个库）：
 *   insert().values({payload: obj})            → jsonb_typeof = 'string'，->> NULL
 *   execute(sql`... values (..., ${obj})`)     → jsonb_typeof = 'object'，->> 正常
 */
async function enqueueMatchJobWith(
  executor: Pick<Db, 'execute'>,
  listingId: string,
): Promise<void> {
  const payload = { listingId }
  await executor.execute(sql`
    INSERT INTO jobs (id, type, payload)
    VALUES (${newId()}, 'MATCH_LISTING', ${payload})
  `)
}
