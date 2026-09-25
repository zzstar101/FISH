import type {
  ListingCategory,
  ListingCondition,
  ListingStatus,
} from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { newListingNo } from '@fish/db/listing-no'
import { jobs } from '@fish/db/schema/jobs'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listingImages, listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
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

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

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
  /**
   * 缺省 = 不按状态过滤。
   *
   * 公开 Feed 由 service 显式传 `ACTIVE`；**卖家查自己的商品且未指定 status** 时不传，
   * 否则 `REVIEW` 店铺（审核中会被写成 `OFFLINE`）就会从「我发布的」里消失 ——
   * 前端那个请求不带 `status`，只看得到 `ACTIVE` 的旧行为让它永远看不到待审商品。
   */
  status?: ListingStatus | undefined
  search?: string | undefined
  category?: ListingCategory | undefined
  priceMinCents?: number | undefined
  priceMaxCents?: number | undefined
  sellerId?: string | undefined
  includeUnapproved?: boolean | undefined
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
  moderationStatus?: 'APPROVED' | 'BLOCKED' | 'REVIEW'
  moderationReason?: string | null
  moderationRuleVersion?: string | null
  moderation?: {
    decision: 'ALLOW' | 'BLOCK' | 'REVIEW'
    matchedRules: string[]
    matchedTermsMasked: string[]
    ruleVersion: string
    priorListingStatus?: ListingStatus | null
  }
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
  moderationStatus?: 'APPROVED' | 'BLOCKED' | 'REVIEW'
  moderationReason?: string | null
  moderationRuleVersion?: string | null
  moderatedAt?: Date
  status?: ListingStatus
}

/** 编辑/下架/上架前需要的当前行状态（权限、状态机、free⟹price 的合并校验都要用）。 */
export type ListingState = {
  sellerId: string
  status: ListingStatus
  title?: string
  description?: string
  priceCents: number
  free: boolean
  governanceDelistedAt: Date | null
}

/**
 * 编辑事务内 `SELECT ... FOR UPDATE` 锁住并读到的当前行。
 * 字段比 `ListingState` 多，因为合并与审核要用到标题/描述等**所有**被部分更新覆盖的列。
 */
export type ListingUpdateTarget = {
  sellerId: string
  status: ListingStatus
  title: string
  description: string
  priceCents: number
  category: ListingCategory
  condition: ListingCondition
  urgent: boolean
  negotiable: boolean
  free: boolean
  moderationStatus: 'APPROVED' | 'BLOCKED' | 'REVIEW'
  governanceDelistedAt: Date | null
  pendingReviewAction?: 'CREATE' | 'UPDATE'
  pendingReviewPriorStatus?: ListingStatus | null
}

/**
 * service 在锁内合并出的写入计划。
 *
 * - `write`：更新商品（+ 可选审核审计 + 可选图片替换）；
 * - `blocked`：内容被阻断，**不写商品**，但要在同一个锁内写一条审计记录。
 *
 * 把"阻断"也放进 plan（而不是让 `apply` 返回 null、由调用方在事务外补写）是为了让审计记录
 * 与锁内读到的那一行严格对应：调用方补写时锁已释放，并发 PATCH 可以让记录的 titleSnapshot
 * 与真正被拒的内容不一致，中途失败还会静默丢失审计行。
 */
export type ListingUpdatePlan =
  | {
      kind: 'write'
      fields: UpdateListingFields
      moderation?: ModerationPlan
    }
  | { kind: 'blocked'; moderation: ModerationPlan }

type ModerationPlan = {
  title: string
  description: string
  decision: 'ALLOW' | 'BLOCK' | 'REVIEW'
  matchedRules: string[]
  matchedTermsMasked: string[]
  ruleVersion: string
  priorListingStatus?: ListingStatus | null
}

/**
 * `updateListingAtomic` 的结果。`'not-found'` 与 `'locked'` 分开，是为了让 service 不必
 * 再读一次状态就能给出 404 / 409（那是 check-then-act 的回归）。
 */
export type ListingUpdateResult =
  | { kind: 'updated' }
  | { kind: 'not-found' }
  /** 行存在但归别人：契约 §3 要求 403，与 404 分开（不泄漏存在性的只有 "不存在" 那一支）。 */
  | { kind: 'not-owner' }
  | { kind: 'locked' }
  | { kind: 'governance-blocked' }
  /** 内容被阻断：商品未改动，但审计记录已在**同一事务内**落库（见 `ListingUpdatePlan`）。 */
  | { kind: 'rejected' }

export interface ListingStore {
  /** 只认迁移时记录的本人旧 ID；旧对象键不得被其它用户冒用。 */
  legacyUserIds(userId: string): Promise<string[]>

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

  /**
   * 编辑商品。改到行时**在同一事务内**投一条 `MATCH_LISTING`（契约 §7.13：标题/描述 → keyword、
   * 价格、分类都是打分输入，不重算就会停在旧分数）。返回 `null` 表示没改到行，此时不投。
   *
   * 交付给调用方的是**事务内 `SELECT ... FOR UPDATE` 读到的**当前行（`ListingUpdateTarget`）：
   * "读当前行 → 合并最终内容 → 审核 → UPDATE" 必须针对同一个快照。只在事务外先读一次、
   * 随后不带版本条件地 UPDATE，两个并发 PATCH 就会各自基于旧快照算审核结论，后提交的那个
   * 把 `moderation_status` 写回 `APPROVED`，留下"待审内容 + APPROVED"（评审 blocker 1）。
   *
   * `apply(input, current)` 由 service 提供，负责在锁内合并、审核并返回一个 `ListingUpdatePlan`：
   * `write` 写商品（可带审核审计与图片替换），`blocked` 只写审计、不写商品。两种情形都在**同一个
   * 锁内事务**内落库 —— 这样 `titleSnapshot` 一定对应被拒的那一行，中途失败也不会只剩半条。
   * 抛异常则整个事务回滚。
   */
  updateListingAtomic(input: {
    id: string
    sellerId: string
    objectKeys?: string[]
    apply: (
      input: {
        id: string
        sellerId: string
        objectKeys?: string[]
      },
      current: ListingUpdateTarget,
    ) => ListingUpdatePlan | Promise<ListingUpdatePlan>
  }): Promise<ListingUpdateResult>

  /**
   * 只从 `from` 迁到 `to`；返回是否真的改了行（并发下可能已被别人改走）。
   *
   * 改到行时**在同一事务内**投一条 `MATCH_LISTING`，`offline` / `online` **两个方向都投**
   * （契约 §7.13：引擎对非 ACTIVE 是 `target-not-active` no-op；重新上架则必须重算，
   * 否则下架期间新建的愿望永远匹配不到它）。没改到行就不投。
   */
  setStatus(input: { id: string; from: ListingStatus; to: ListingStatus }): Promise<boolean>
  recordModeration?(input: {
    listingId?: string
    sellerId: string
    action: 'CREATE' | 'UPDATE'
    title: string
    description: string
    decision: 'ALLOW' | 'BLOCK' | 'REVIEW'
    matchedRules: string[]
    matchedTermsMasked: string[]
    ruleVersion: string
    priorListingStatus?: ListingStatus | null
  }): Promise<void>
}

/** 新商品默认落 `ACTIVE`。 */
const NEW_LISTING_STATUS: ListingStatus = 'ACTIVE'

/**
 * 交易域（#11）写的状态：卖家不能编辑、不能下架、不能上架。
 *
 * 定义在这里并导出，是因为它有两个使用点且必须完全一致：SQL 的 UPDATE 谓词（本文件）
 * 与 service 的 409 判定。两处各写一份就会出现"service 拒绝、SQL 放行"的裂缝。
 */
export const LOCKED_LISTING_STATUSES: ListingStatus[] = ['RESERVED', 'SOLD']

/** 编辑事务内被锁定的列：合并审核要用到的全部可变列。 */
const EDITABLE_COLUMNS = {
  sellerId: listings.sellerId,
  status: listings.status,
  title: listings.title,
  description: listings.description,
  priceCents: listings.priceCents,
  category: listings.category,
  condition: listings.condition,
  urgent: listings.urgent,
  negotiable: listings.negotiable,
  free: listings.free,
  moderationStatus: listings.moderationStatus,
  governanceDelistedAt: listings.governanceDelistedAt,
} as const

export function createSqlListingStore(db: Db): ListingStore {
  return {
    async legacyUserIds(userId) {
      const result = await db.execute(sql`
        SELECT old_id FROM id_rekeys WHERE resource_table = 'users' AND new_id = ${userId}::uuid
      `)
      return rowsOf(result).map((row) => String(row.old_id))
    },

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

        // Claim before inserting the listing. A collision is resolved without aborting the
        // surrounding transaction; all later writes (images/job) roll back with the claim.
        let listingNo: bigint | undefined
        for (let attempt = 0; attempt < 16; attempt++) {
          const candidate = newListingNo()
          const claimed = await tx
            .insert(listingNumbers)
            .values({ listingNo: candidate, listingId: record.id })
            .onConflictDoNothing({ target: listingNumbers.listingNo })
            .returning({ listingNo: listingNumbers.listingNo })
          if (claimed[0]) {
            listingNo = claimed[0].listingNo
            break
          }
        }
        if (listingNo === undefined) throw new Error('无法分配唯一的商品编号')

        await tx.insert(listings).values({
          id: record.id,
          listingNo,
          sellerId: record.sellerId,
          title: record.title,
          description: record.description,
          priceCents: record.priceCents,
          category: record.category,
          condition: record.condition,
          status: record.moderationStatus === 'REVIEW' ? 'OFFLINE' : NEW_LISTING_STATUS,
          moderationStatus: record.moderationStatus ?? 'APPROVED',
          moderationReason: record.moderationReason ?? null,
          moderationRuleVersion: record.moderationRuleVersion ?? null,
          moderatedAt: new Date(),
          urgent: record.urgent,
          negotiable: record.negotiable,
          free: record.free,
        })

        if (record.moderation) {
          await tx.insert(listingModerationRecords).values({
            listingId: record.id,
            sellerId: record.sellerId,
            action: 'CREATE',
            titleSnapshot: record.title,
            descriptionSnapshot: record.description,
            decision: record.moderation.decision,
            // `jsonParam` 包一层：裸数组在 drizzle + bun-sql 下会被 stringify 两次，
            // 落库成 `jsonb_typeof = 'string'`（与 jobs.payload 同一个已踩过的坑）。
            // 读路径会 parse 两次而“看起来正常”，但 `@>` / `jsonb_array_length` 全都失效。
            matchedRules: jsonParam(record.moderation.matchedRules),
            matchedTermsMasked: jsonParam(record.moderation.matchedTermsMasked),
            ruleVersion: record.moderation.ruleVersion,
            priorListingStatus: record.moderation.priorListingStatus ?? null,
          })
        }

        // 下标即 sortOrder（0 = 封面），与 #6 契约 §1 和 DB 的
        // listing_images_listing_id_sort_order_uq 唯一索引一致。
        await tx.insert(listingImages).values(
          record.objectKeys.map((objectKey, index) => ({
            listingId: record.id,
            objectKey,
            sortOrder: index,
          })),
        )

        if ((record.moderationStatus ?? 'APPROVED') === 'APPROVED') {
          await enqueueMatchJobWith(tx, record.id)
        }

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
          title: listings.title,
          description: listings.description,
          priceCents: listings.priceCents,
          free: listings.free,
          governanceDelistedAt: listings.governanceDelistedAt,
        })
        .from(listings)
        .where(eq(listings.id, id))
        .limit(1)

      return rows[0] ?? null
    },

    async listFeed(criteria) {
      const conditions: SQL[] = [
        ...(criteria.status ? [eq(listings.status, criteria.status)] : []),
        ...(criteria.includeUnapproved ? [] : [eq(listings.moderationStatus, 'APPROVED')]),
      ]

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
        //
        // `q` 里的 `%` / `_` / `\` 必须转义：否则 `?q=%` 会匹配整张表、`?q=a_b` 会把 `_`
        // 当成单字符通配 —— 契约写的是"匹配范围"，用户期待的是字面子串匹配。
        //
        // 不用写 `ESCAPE` 子句：反斜杠本来就是 PostgreSQL 的 LIKE/ILIKE 默认转义符，
        // 而显式写 `ESCAPE '\'` 反而引入新的依赖 —— 那个字面量只在
        // `standard_conforming_strings = on` 时合法（PG 默认值），关掉它整条语句就变成语法错误。
        // 转义后的 pattern 是**参数**，与这个 GUC 无关。
        const escaped = criteria.search.replace(/[\\%_]/g, '\\$&')
        const pattern = `%${escaped}%`
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

    async updateListingAtomic(input) {
      return db.transaction(async (tx) => {
        // 先锁行再读："读当前行 → 合并 → 审核 → UPDATE" 必须落在同一快照上。
        // 没有这个锁时，两个并发 PATCH 会各自读到旧行、各自算审核结论，后提交的那个把
        // `moderation_status` 写回 APPROVED，留下"待审内容 + APPROVED"（评审 blocker 1）。
        const current = await tx
          .select(EDITABLE_COLUMNS)
          .from(listings)
          .where(eq(listings.id, input.id))
          .for('update')
          .limit(1)

        const row = current[0]
        if (!row) return { kind: 'not-found' as const }
        if (row.sellerId !== input.sellerId) return { kind: 'not-owner' as const }
        if (LOCKED_LISTING_STATUSES.includes(row.status)) return { kind: 'locked' as const }
        // 与管理员下架串行：锁内检查，卖家的 PATCH 不能清除治理标记。
        if (row.governanceDelistedAt) return { kind: 'governance-blocked' as const }

        let updateTarget: ListingUpdateTarget = row
        if (row.moderationStatus === 'REVIEW') {
          const pendingRoot = await tx.execute(sql`
            SELECT action, prior_listing_status::text AS prior_listing_status
            FROM listing_moderation_records
            WHERE listing_id = ${input.id}
              AND decision = 'REVIEW'
              AND created_at > COALESCE(
                (
                  SELECT MAX(created_at)
                  FROM listing_moderation_records
                  WHERE listing_id = ${input.id}
                    AND action = 'MANUAL_DECISION'
                ),
                '-infinity'::timestamptz
              )
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          `)
          const root = rowsOf(pendingRoot)[0]
          updateTarget = {
            ...row,
            pendingReviewAction:
              root?.action === 'CREATE' || root?.action === 'UPDATE' ? root.action : undefined,
            pendingReviewPriorStatus: (root?.prior_listing_status as ListingStatus | null) ?? null,
          }
        }

        const plan = await input.apply(input, updateTarget)
        // 阻断：不写商品，但审计记录与锁内读到的那一行同事务落库。
        if (plan.kind === 'blocked') {
          await tx.insert(listingModerationRecords).values({
            listingId: input.id,
            sellerId: input.sellerId,
            action: 'UPDATE',
            titleSnapshot: plan.moderation.title,
            descriptionSnapshot: plan.moderation.description,
            decision: plan.moderation.decision,
            matchedRules: jsonParam(plan.moderation.matchedRules),
            matchedTermsMasked: jsonParam(plan.moderation.matchedTermsMasked),
            ruleVersion: plan.moderation.ruleVersion,
            priorListingStatus: plan.moderation.priorListingStatus ?? null,
          })
          return { kind: 'rejected' as const }
        }

        const rows = await tx
          .update(listings)
          .set({ ...plan.fields, updatedAt: new Date() })
          .where(eq(listings.id, input.id))
          .returning({ id: listings.id })
        if (rows.length === 0) return { kind: 'not-found' as const }

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

        if (plan.moderation) {
          await tx.insert(listingModerationRecords).values({
            listingId: input.id,
            sellerId: input.sellerId,
            action: 'UPDATE',
            titleSnapshot: plan.moderation.title,
            descriptionSnapshot: plan.moderation.description,
            decision: plan.moderation.decision,
            // 见 createListingAtomic 里的同一条说明：jsonb 数组必须经 `jsonParam`。
            matchedRules: jsonParam(plan.moderation.matchedRules),
            matchedTermsMasked: jsonParam(plan.moderation.matchedTermsMasked),
            ruleVersion: plan.moderation.ruleVersion,
            priorListingStatus: plan.moderation.priorListingStatus ?? null,
          })
        }

        // 审核中的商品不可进入匹配链路；只有通过审核的编辑才需要重算匹配。
        if ((plan.fields.moderationStatus ?? 'APPROVED') !== 'APPROVED') {
          return { kind: 'updated' as const }
        }

        // 编辑会改变打分输入（标题/描述 → keyword，价格、分类直接参与打分），所以必须重算匹配，
        // 否则 `matches` 里那一对会一直是旧分数（#8 契约 §3.3 的"matches 行 = 当前有效匹配"就不成立）。
        // 投递与写入同一事务：编辑成功而 job 丢失会让该商品永久停在旧分数。
        // 即使只改了图片也照投：规则简单（一条 PATCH = 一条 job），重算本身幂等且不会重复建通知。
        await enqueueMatchJobWith(tx, input.id)

        return { kind: 'updated' as const }
      })
    },

    async recordModeration(input) {
      await db.insert(listingModerationRecords).values({
        listingId: input.listingId,
        sellerId: input.sellerId,
        action: input.action,
        titleSnapshot: input.title,
        descriptionSnapshot: input.description,
        decision: input.decision,
        // 见 createListingAtomic 里的同一条说明：jsonb 数组必须经 `jsonParam`。
        matchedRules: jsonParam(input.matchedRules),
        matchedTermsMasked: jsonParam(input.matchedTermsMasked),
        ruleVersion: input.ruleVersion,
        priorListingStatus: input.priorListingStatus ?? null,
      })
    },

    async setStatus(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(listings)
          .set({ status: input.to, updatedAt: new Date() })
          .where(
            and(
              eq(listings.id, input.id),
              eq(listings.status, input.from),
              ...(input.to === 'ACTIVE' ? [eq(listings.moderationStatus, 'APPROVED')] : []),
            ),
          )
          .returning({ id: listings.id })

        // 没改到行（并发下别人先改了，或已经不在 from 状态）就不投：没有状态变化就没有重算的必要。
        if (rows.length === 0) return false

        // 两个方向都投：
        // - `ACTIVE`（重新上架）：下架期间新建的愿望必须能匹配上，否则商品永远等不到新的"愿望成真"；
        // - `OFFLINE`（下架）：引擎对非 ACTIVE 是 `target-not-active` no-op，投了无害，
        //   而"凡是可能改变匹配结果的写操作都投一条"这条规则不必再记例外。
        await enqueueMatchJobWith(tx, input.id)

        return true
      })
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
 * `payload` 必须经 `jsonParam()` 包装：直接用裸对象会被 drizzle + `bun-sql` stringify 两次，
 * 落库成为「JSON 字符串套 JSON」，于是 `payload->>'listingId'` 在 SQL 层恒为 NULL，
 * #8 的 worker 就再也匹配不到这个商品（详见 `@fish/db/json` 的实测说明）。
 */
async function enqueueMatchJobWith(executor: Pick<Db, 'insert'>, listingId: string): Promise<void> {
  await executor.insert(jobs).values({
    id: newId(),
    type: 'MATCH_LISTING',
    payload: jsonParam({ listingId }),
  })
}
