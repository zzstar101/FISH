import type {
  ListingCategory,
  ListingCondition,
  ListingStatus,
} from '@fish/contracts/listings/schema'
import type { RentalSort } from '@fish/contracts/rentals/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { newListingNo } from '@fish/db/listing-no'
import { listingWantsCount } from '@fish/db/listing-wants'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listingImages, listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { rentalTerms } from '@fish/db/schema/rentals'
import { users } from '@fish/db/schema/users'
import { and, asc, desc, eq, gt, gte, inArray, lte, or, type SQL, sql } from 'drizzle-orm'

/**
 * 租赁域持久化（#706 RNT-02）。
 *
 * ## 为什么与 `listings/store.ts` 分开
 *
 * 出租的读写语义与出售不同（日租价、押金、可用租期、条款版本），把它们塞进出售 store 会让
 * 每一个既有方法都多一个「这行是不是出租」的判断分支。这里只覆盖出租需要的操作，
 * 底层复用同一张 `listings` 表（#705 已让 `listing_type` 成为一等公民）。
 *
 * ## 事务边界
 *
 * 「创建 Listing」与「创建条款」**必须同事务**：验收要求「创建失败时无缺条款的公开商品」。
 * 拆成两次写入会在中间留下一条没有条款的 RENTAL 行，而那一行是**公开可见**的
 * （`status = ACTIVE` + `moderation_status = APPROVED`），端上读到就会因缺条款渲染失败。
 */

export type RentalListingRow = typeof listings.$inferSelect
export type RentalTermsRow = typeof rentalTerms.$inferSelect

/** 列表/详情投影：商品行 + 条款 + 出租人公开子集 + 封面键。 */
export type RentalEntry = {
  listing: RentalListingRow
  terms: RentalTermsRow
  owner: {
    id: string
    nickname: string
    avatarUrl: string | null
    authStatus: 'UNVERIFIED' | 'VERIFIED'
  }
  coverObjectKey: string | null
  wants: number
  /** 微秒精度 `created_at` 文本（仅用于构造 `newest` 游标）。 */
  createdAtCursor: string
}

export type RentalFeedCriteria = {
  limit: number
  sort: RentalSort
  cursor: { sortKey: string | number; id: string } | null
  search?: string | undefined
  /** 只要「能租满 N 天」的商品（`min_days <= N <= max_days`）。 */
  days?: number | undefined
  /** 本人视角：不筛状态、包含未过审。 */
  ownerId?: string | undefined
  includeUnapproved?: boolean | undefined
}

export type CreateRentalRecord = {
  id: string
  ownerId: string
  title: string
  description: string
  dailyPriceCents: number
  depositCents: number
  rules: string | null
  minDays: number
  maxDays: number
  condition: ListingCondition
  objectKeys: string[]
  moderationStatus: 'APPROVED' | 'REVIEW'
  moderationReason: string | null
  moderationRuleVersion: string | null
  moderation: {
    decision: 'ALLOW' | 'REVIEW'
    ruleVersion: string
    provider: string | null
    providerRequestId: string | null
    suggestion: string | null
    label: string | null
    subLabel: string | null
    score: number | null
    /**
     * 审核记录里的「编辑前状态」。新建时恒 null；编辑时由 service 按锁前读到的那一行填，
     * 让审计能区分「从 ACTIVE 改下来」与「本来就 OFFLINE」。
     */
    priorListingStatus: ListingStatus | null
  }
  /** 查重窗口起点（与出售同一 5 秒口径）。 */
  duplicateWindowStart: Date
}

export type CreateRentalResult =
  | { kind: 'created'; listingId: string }
  | { kind: 'duplicate'; listingId: string }

export type UpdateRentalResult =
  | { kind: 'updated'; listingId: string }
  | { kind: 'not-found' }
  | { kind: 'not-owner' }
  | { kind: 'not-editable' }
  /** 合并后的租期违约（`maxDays < minDays`）。锁内判定，见 `updateRentalAtomic`。 */
  | { kind: 'terms-invalid' }

export interface RentalStore {
  /** 交易性创建：Listing + 条款 + 图片 + 审核记录**同一事务**。 */
  createRentalAtomic(record: CreateRentalRecord): Promise<CreateRentalResult>
  /** 列表（广场 / 我的出租）。多取一行由调用方判 `hasMore`。 */
  listRentals(criteria: RentalFeedCriteria): Promise<RentalEntry[]>
  /** 详情：商品 + 条款 + 出租人。不存在返回 `null`。 */
  findRentalDetail(listingId: string): Promise<RentalEntry | null>
  /** 编辑（含条款版本递增）。条款字段与 Listing 字段在同一事务。 */
  updateRentalAtomic(input: {
    listingId: string
    ownerId: string
    /** 审计记录要写的完整文本（review 过的那一份），不是本次 patch。 */
    auditSnapshot: { title: string; description: string }
    listingFields: Partial<{
      title: string
      description: string
      condition: ListingCondition
    }>
    termsFields: Partial<{
      dailyPriceCents: number
      depositCents: number
      rules: string | null
      minDays: number
      maxDays: number
    }>
    objectKeys?: string[]
    moderation?: CreateRentalRecord['moderation']
    moderationStatus?: 'APPROVED' | 'REVIEW'
    moderationReason?: string | null
    moderationRuleVersion?: string | null
  }): Promise<UpdateRentalResult>
  /** 当前图片键（按 sort_order）。编辑不带 `objectKeys` 时靠它回读图片结论。 */
  listImageKeys(listingId: string): Promise<string[]>
  /** 上下架：条件更新，只对 RENTAL 生效。返回是否改到行。 */
  setStatus(input: {
    listingId: string
    from: 'ACTIVE' | 'OFFLINE'
    to: 'ACTIVE' | 'OFFLINE'
  }): Promise<boolean>
  /** 该用户是否有资格发布出租（教育邮箱认证 + 账号可用）。 */
  isEligibleOwner(userId: string): Promise<boolean>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

// `jsonParam` 在 `@fish/db/json`；创建审核记录时必须包一层（裸数组会被 stringify 两次）。

const ENTRY_COLUMNS = {
  listing: listings,
  /**
   * 微秒精度的 `created_at` 文本，**只供构造游标**。
   *
   * 为什么不能由 `listing.createdAt.toISOString()` 推导：JS `Date` 只有毫秒，而
   * `created_at` 是 timestamptz（微秒）。截断后同一毫秒内排在游标行之后的行
   * 「既不小于、也不等于」游标值，翻页时会**永久消失**（与 `listings/cursor.ts`
   * 记录的同一个坑，那里也是用 `to_char(..., '.US')` 解决的）。
   */
  createdAtCursor: sql<string>`to_char(${listings.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  terms: rentalTerms,
  owner: {
    id: users.id,
    nickname: users.nickname,
    avatarUrl: users.avatarUrl,
    authStatus: users.authStatus,
  },
} as const

/** 广场的公开可见性（与 `listings` 的 `ACTIVE + APPROVED` 同口径，另加治理下架排除）。 */
function publicRentalConditions(): SQL[] {
  return [
    eq(listings.listingType, 'RENTAL'),
    eq(listings.status, 'ACTIVE'),
    eq(listings.moderationStatus, 'APPROVED'),
    sql`${listings.governanceDelistedAt} IS NULL`,
  ]
}

/** 游标条件：`(created_at, id) <` 或 `(price, id) <`，与各自的排序同向。 */
function cursorCondition(criteria: RentalFeedCriteria): SQL | undefined {
  const cursor = criteria.cursor
  if (!cursor) return undefined
  if (criteria.sort === 'newest') {
    const createdAt = String(cursor.sortKey)
    return or(
      sql`${listings.createdAt} < ${createdAt}::timestamptz`,
      and(
        sql`${listings.createdAt} = ${createdAt}::timestamptz`,
        sql`${listings.id} < ${cursor.id}::uuid`,
      ),
    ) as SQL
  }
  const price = Number(cursor.sortKey)
  if (criteria.sort === 'priceAsc') {
    return or(
      gte(listings.priceCents, price + 1),
      and(eq(listings.priceCents, price), sql`${listings.id} < ${cursor.id}::uuid`),
    ) as SQL
  }
  return or(
    lte(listings.priceCents, price - 1),
    and(eq(listings.priceCents, price), sql`${listings.id} < ${cursor.id}::uuid`),
  ) as SQL
}

export function createSqlRentalStore(db: Db): RentalStore {
  return {
    async isEligibleOwner(userId) {
      // M0 冻结：出租资格 = 教育邮箱认证（`auth_status = 'VERIFIED'`，该值只由校园邮箱验证写入）
      // + 账号可用。治理封禁由 `restrictionGuard.publish` 在路由层挡，不在这里重复查。
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, userId),
            eq(users.authStatus, 'VERIFIED'),
            eq(users.accountStatus, 'ACTIVE'),
          ),
        )
        .limit(1)
      return rows.length > 0
    },

    async createRentalAtomic(record) {
      return db.transaction(async (tx) => {
        // 同一卖家串行化（与出售发布同一手法）：并发的双击提交不会各插一行。
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${record.ownerId}))`)

        // 查重窗口只在**同类型**内部生效（#705 已给出售侧加了 `listingType = 'SALE'`，
        // 这里对应地只比 RENTAL）。否则一件同名的出租会把另一次合法出租判成重复。
        const duplicate = await tx
          .select({ id: listings.id })
          .from(listings)
          .where(
            and(
              eq(listings.sellerId, record.ownerId),
              eq(listings.title, record.title),
              eq(listings.priceCents, record.dailyPriceCents),
              eq(listings.category, 'DIGITAL'),
              eq(listings.listingType, 'RENTAL'),
              gt(listings.createdAt, record.duplicateWindowStart),
            ),
          )
          .orderBy(desc(listings.createdAt))
          .limit(1)

        const existing = duplicate[0]
        if (existing) return { kind: 'duplicate' as const, listingId: existing.id }

        // 先占编号再插行（碰撞不中止事务；后续写入随事务回滚）。
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
          sellerId: record.ownerId,
          title: record.title,
          description: record.description,
          // 出租的 `price_cents` 存**日租单价**（整数分）。广场与详情都按这个口径读。
          priceCents: record.dailyPriceCents,
          // M0 冻结：仅数码。写路径不接受客户端指定品类，这里写死。
          category: 'DIGITAL',
          condition: record.condition,
          listingType: 'RENTAL',
          status: record.moderationStatus === 'REVIEW' ? 'OFFLINE' : 'ACTIVE',
          moderationStatus: record.moderationStatus,
          moderationReason: record.moderationReason,
          moderationRuleVersion: record.moderationRuleVersion,
          moderatedAt: new Date(),
          // 出租没有「急出 / 可议价 / 免费送」这三个出售语义位，一律 false。
          urgent: false,
          negotiable: false,
          free: false,
        })

        // **同一事务**写条款：任何一步失败，上面那条 listings 行也随事务回滚，
        // 不会留下「缺条款的公开商品」（验收项）。
        await tx.insert(rentalTerms).values({
          listingId: record.id,
          depositCents: record.depositCents,
          rules: record.rules,
          minDays: record.minDays,
          maxDays: record.maxDays,
          termsVersion: 1,
        })

        await tx.insert(listingModerationRecords).values({
          listingId: record.id,
          sellerId: record.ownerId,
          action: 'CREATE',
          titleSnapshot: record.title,
          descriptionSnapshot: record.description,
          matchedRules: jsonParam([]),
          matchedTermsMasked: jsonParam([]),
          ...record.moderation,
        })

        await tx.insert(listingImages).values(
          record.objectKeys.map((objectKey, index) => ({
            listingId: record.id,
            objectKey,
            sortOrder: index,
          })),
        )

        return { kind: 'created' as const, listingId: record.id }
      })
    },

    async listRentals(criteria) {
      const conditions: SQL[] = criteria.ownerId
        ? [eq(listings.listingType, 'RENTAL'), eq(listings.sellerId, criteria.ownerId)]
        : publicRentalConditions()

      if (!criteria.includeUnapproved) {
        // 公开广场：审核通过才出现。本人视角由 `includeUnapproved` 放开。
        conditions.push(eq(listings.moderationStatus, 'APPROVED'))
      }
      if (criteria.search) {
        // 与出售 Feed 同一转义口径：`%` / `_` / `\` 走字面匹配。
        const escaped = criteria.search.replace(/[\\%_]/g, '\\$&')
        const pattern = `%${escaped}%`
        const searchCondition = or(
          sql`${listings.title} ILIKE ${pattern}`,
          sql`${listings.description} ILIKE ${pattern}`,
        )
        if (searchCondition) conditions.push(searchCondition)
      }
      if (criteria.days !== undefined) {
        conditions.push(lte(rentalTerms.minDays, criteria.days))
        conditions.push(gte(rentalTerms.maxDays, criteria.days))
      }

      const cursorWhere = cursorCondition(criteria)
      if (cursorWhere) conditions.push(cursorWhere)

      const orderBy =
        criteria.sort === 'newest'
          ? [desc(listings.createdAt), desc(listings.id)]
          : criteria.sort === 'priceAsc'
            ? [asc(listings.priceCents), desc(listings.id)]
            : [desc(listings.priceCents), desc(listings.id)]

      const rows = await db
        .select(ENTRY_COLUMNS)
        .from(listings)
        .innerJoin(rentalTerms, eq(rentalTerms.listingId, listings.id))
        .innerJoin(users, eq(users.id, listings.sellerId))
        .where(and(...conditions))
        .orderBy(...orderBy)
        // 多取一行判 hasMore，返回前丢掉。
        .limit(criteria.limit + 1)

      if (rows.length === 0) return []

      const pageIds = rows.map((row) => row.listing.id)
      const covers = await db
        .select({ listingId: listingImages.listingId, objectKey: listingImages.objectKey })
        .from(listingImages)
        .where(and(inArray(listingImages.listingId, pageIds), eq(listingImages.sortOrder, 0)))
      const coverByListing = new Map(covers.map((cover) => [cover.listingId, cover.objectKey]))

      // 「想要数」是出售语义（已建会话的买家数）；出租 V1 没有这个概念，恒为 0 —— 但接口
      // 形状与出售卡片一致（万一将来端上要复用同一行渲染，不必改契约）。
      return rows.map((row) => ({
        listing: row.listing,
        terms: row.terms,
        owner: row.owner,
        coverObjectKey: coverByListing.get(row.listing.id) ?? null,
        wants: 0,
        createdAtCursor: row.createdAtCursor,
      }))
    },

    async findRentalDetail(listingId) {
      const rows = await db
        .select(ENTRY_COLUMNS)
        .from(listings)
        .innerJoin(rentalTerms, eq(rentalTerms.listingId, listings.id))
        .innerJoin(users, eq(users.id, listings.sellerId))
        .where(and(eq(listings.id, listingId), eq(listings.listingType, 'RENTAL')))
        .limit(1)

      const row = rows[0]
      if (!row) return null

      const covers = await db
        .select({ objectKey: listingImages.objectKey })
        .from(listingImages)
        .where(and(eq(listingImages.listingId, listingId), eq(listingImages.sortOrder, 0)))
        .limit(1)

      // 出租 V1 没有「想要数」；保留字段是为了与出售卡片同形状（见 listRentals 的说明）。
      // `listingWantsCount` 在这里不调用：它统计的是买卖会话数，对出租恒 0 且多一次探测。
      void listingWantsCount

      return {
        listing: row.listing,
        terms: row.terms,
        owner: row.owner,
        coverObjectKey: covers[0]?.objectKey ?? null,
        wants: 0,
        createdAtCursor: row.createdAtCursor,
      }
    },

    async listImageKeys(listingId) {
      const rows = await db
        .select({ objectKey: listingImages.objectKey })
        .from(listingImages)
        .where(eq(listingImages.listingId, listingId))
        .orderBy(asc(listingImages.sortOrder))
      return rows.map((row) => row.objectKey)
    },

    async updateRentalAtomic(input) {
      return db.transaction(async (tx) => {
        // 锁行再判定：并发侧（预约/接单）会在锁上排队，结论不会在「读完 → 写入」之间失效。
        const current = await tx.execute(sql`
          SELECT seller_id::text AS seller_id,
                 listing_type::text AS listing_type,
                 status::text AS status,
                 moderation_status::text AS moderation_status,
                 governance_delisted_at
          FROM listings WHERE id = ${input.listingId} FOR UPDATE
        `)
        const row = rowsOf(current)[0]
        if (!row) return { kind: 'not-found' as const }
        // 出租的编辑只走本端点：出售端点会按类型 404，反之亦然。
        if (String(row.listing_type) !== 'RENTAL') return { kind: 'not-found' as const }
        if (String(row.seller_id) !== input.ownerId) return { kind: 'not-owner' as const }
        // 平台下架（治理）期间不允许卖家改内容：与出售编辑同一口径。
        if (row.governance_delisted_at !== null) return { kind: 'not-editable' as const }

        /*
         * 租期关系必须在**锁内**按合并后的最终状态判定（审查 P1）：
         * service 在事务外读过一次 `min/max`，但两个各自合法的并发 PATCH
         * （`{minDays: 10}` 与 `{maxDays: 3}`）合并后可能违约，那时 DB 的 CHECK 会抛裸
         * `DrizzleQueryError` → 500。锁内重算一遍并把违约翻译成 `terms-invalid`。
         */
        const lockedTerms = rowsOf(
          await tx.execute(sql`
            SELECT min_days, max_days FROM rental_terms WHERE listing_id = ${input.listingId}
          `),
        )[0]
        if (!lockedTerms) return { kind: 'not-found' as const }
        const finalMin = input.termsFields.minDays ?? Number(lockedTerms.min_days)
        const finalMax = input.termsFields.maxDays ?? Number(lockedTerms.max_days)
        if (finalMax < finalMin) return { kind: 'terms-invalid' as const }

        const listingPatch: Record<string, unknown> = { updatedAt: sql`clock_timestamp()` }
        if (input.listingFields.title !== undefined) listingPatch.title = input.listingFields.title
        if (input.listingFields.description !== undefined) {
          listingPatch.description = input.listingFields.description
        }
        if (input.listingFields.condition !== undefined) {
          listingPatch.condition = input.listingFields.condition
        }
        if (input.moderationStatus !== undefined) {
          listingPatch.moderationStatus = input.moderationStatus
          listingPatch.moderationReason = input.moderationReason ?? null
          listingPatch.moderationRuleVersion = input.moderationRuleVersion ?? null
          listingPatch.moderatedAt = new Date()
          /*
           * **只在 REVIEW 时改状态**，且只改成 OFFLINE。
           *
           * 不能像 SALE 早期写法那样无条件写 `APPROVED → ACTIVE`：卖家主动 `POST /offline`
           * 下架后，一次纯文本编辑会把它悄悄重新公开 —— 那等于绕过卖家的下架决定
           * （审查实测：offline → 改标题 → 又出现在广场）。
           * APPROVED 时**不动** `status`：保持卖家当前的选择（ACTIVE 仍是 ACTIVE，
           * OFFLINE 仍是 OFFLINE）。这与 `moderation/store.ts` 的 `prior_listing_status`
           * 恢复语义一致，但不需要额外存一列 —— 因为这里压根不改它。
           */
          if (input.moderationStatus === 'REVIEW') listingPatch.status = 'OFFLINE'
        }

        await tx.update(listings).set(listingPatch).where(eq(listings.id, input.listingId))

        const termsPatch: Record<string, unknown> = {}
        if (input.termsFields.dailyPriceCents !== undefined) {
          // 日租价存在 `listings.price_cents`（广场排序与卡片同源）。
          await tx
            .update(listings)
            .set({
              priceCents: input.termsFields.dailyPriceCents,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(listings.id, input.listingId))
        }
        if (input.termsFields.depositCents !== undefined) {
          termsPatch.depositCents = input.termsFields.depositCents
        }
        if (input.termsFields.rules !== undefined) termsPatch.rules = input.termsFields.rules
        if (input.termsFields.minDays !== undefined) termsPatch.minDays = input.termsFields.minDays
        if (input.termsFields.maxDays !== undefined) termsPatch.maxDays = input.termsFields.maxDays

        // 任一条款字段变化都要递增版本（验收：「仅修改价格、押金或规则中的任一项也会更新条款版本」）。
        // 用 SQL 自增而不是读-改-写：并发两次修改各自 +1，不丢更新。
        const termsChanged =
          input.termsFields.dailyPriceCents !== undefined ||
          input.termsFields.depositCents !== undefined ||
          input.termsFields.rules !== undefined ||
          input.termsFields.minDays !== undefined ||
          input.termsFields.maxDays !== undefined

        if (termsChanged) {
          await tx
            .update(rentalTerms)
            .set({
              ...termsPatch,
              termsVersion: sql`${rentalTerms.termsVersion} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(rentalTerms.listingId, input.listingId))
        }

        if (input.objectKeys !== undefined) {
          await tx.delete(listingImages).where(eq(listingImages.listingId, input.listingId))
          await tx.insert(listingImages).values(
            input.objectKeys.map((objectKey, index) => ({
              listingId: input.listingId,
              objectKey,
              sortOrder: index,
            })),
          )
        }

        if (input.moderation) {
          await tx.insert(listingModerationRecords).values({
            listingId: input.listingId,
            sellerId: input.ownerId,
            action: 'UPDATE',
            titleSnapshot: input.auditSnapshot.title,
            descriptionSnapshot: input.auditSnapshot.description,
            matchedRules: jsonParam([]),
            matchedTermsMasked: jsonParam([]),
            ...input.moderation,
          })
        }

        return { kind: 'updated' as const, listingId: input.listingId }
      })
    },

    async setStatus(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(listings)
          .set({ status: input.to, updatedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(listings.id, input.listingId),
              eq(listings.listingType, 'RENTAL'),
              eq(listings.status, input.from),
              // 上架要求审核通过（与出售的 `setStatus` 同一判据）。
              ...(input.to === 'ACTIVE' ? [eq(listings.moderationStatus, 'APPROVED')] : []),
            ),
          )
          .returning({ id: listings.id })
        return rows.length > 0
      })
    },
  }
}

/** 生成新的出租商品 id（UUIDv7，与仓库其它域同一来源）。 */
export function newRentalListingId(): string {
  return newId()
}

/** 商品分类的出租白名单（M0 冻结：仅数码）。 */
export const RENTAL_ALLOWED_CATEGORY: ListingCategory = 'DIGITAL'
