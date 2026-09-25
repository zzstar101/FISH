import type { ListingCard } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { eq, sql } from 'drizzle-orm'
import type { UserRow } from '../auth/me'

/** 我发布的商品行（含封面 objectKey；URL 由共享映射 listings/card 拼）。 */
export interface ProfileListingRow {
  id: string
  listingNo: bigint
  title: string
  priceCents: number
  category: ListingCard['category']
  condition: ListingCard['condition']
  status: ListingCard['status']
  urgent: boolean
  negotiable: boolean
  free: boolean
  createdAt: Date
  coverObjectKey: string | null
}

/** 我的愿望行：形状对齐 wishes 模块的 WishRow（复用其导出的 toWishDto，避免映射漂移）。 */
export interface ProfileWishRow {
  id: string
  user_id: string
  keyword: string
  category: string
  budget_min_cents: number
  budget_max_cents: number
  description: string | null
  accept_similar: boolean
  status: string
  match_count: number
  created_at: Date | string
  updated_at: Date | string
}

export interface ProfileTransactionRow {
  id: string
  listingId: string
  buyerId: string
  amountCents: number
  status: string
  createdAt: Date | string
  /** 订单卡内嵌的商品摘要（join listings + 封面子查询）；脏数据行为 null 时由 service 跳过。 */
  listing: {
    title: string
    priceCents: number
    status: string
    coverObjectKey: string | null
  } | null
  /** 交易对方（查看者视角解析）；users 行缺失视为脏数据，由 service 跳过。 */
  counterpart: {
    id: string
    nickname: string
    avatarUrl: string | null
  } | null
}

export interface ProfileStatsRow {
  activeListings: number
  activeWishes: number
  completedTransactions: number
}

export interface ProfileStore {
  stats(userId: string): Promise<ProfileStatsRow>
  ownListings(userId: string, limit: number): Promise<ProfileListingRow[]>
  ownWishes(userId: string, limit: number): Promise<ProfileWishRow[]>
  ownTransactions(userId: string, limit: number): Promise<ProfileTransactionRow[]>
  /**
   * #86 B：本域**唯一**的写操作——只改传入的列（昵称 / 头像 URL）。
   *
   * 回整行而不是只回 `Me`：对外映射统一走认证域的 `toMe`（头像脏值降级、
   * 手机号只出派生态都在那里），本域不复制第二份。
   * 行不存在（认证与写入之间账号被删）回 `null`，由 service 决定怎么报。
   */
  updateUser(
    userId: string,
    patch: { nickname?: string; avatarUrl?: string },
  ): Promise<UserRow | null>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

export function createSqlProfileStore(db: Db): ProfileStore {
  return {
    async stats(userId) {
      // 统计口径必须与列表口径一致，否则个人中心会出现「统计 N 条、列表 M 条」的自相矛盾。
      // 只跟着 ownWishes 的**可表示性**过滤（category 非空）走：预算为 NULL 的愿望是真实
      // 存在的 shape（seed 的 wishKeyboard 就是），把它一并排除会让演示账号「小北」的愿望
      // 在统计与列表里双双消失，而 #7 的 /wishes 明明看得见它。
      const result = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM listings
            WHERE seller_id = ${userId} AND status = 'ACTIVE') AS active_listings,
          (SELECT count(*)::int FROM wishes
            WHERE user_id = ${userId} AND status = 'ACTIVE'
              AND category IS NOT NULL) AS active_wishes,
          (SELECT count(*)::int FROM transactions
            WHERE (buyer_id = ${userId} OR seller_id = ${userId}) AND status = 'COMPLETED')
            AS completed_transactions
      `)
      const row = rowsOf(result)[0]
      if (!row) throw new Error('Profile 统计查询未返回行')
      return {
        activeListings: Number(row.active_listings),
        activeWishes: Number(row.active_wishes),
        completedTransactions: Number(row.completed_transactions),
      }
    },

    async ownListings(userId, limit) {
      // 本人视角：不筛 status（OFFLINE/RESERVED/SOLD 都是自己可见的）。
      // 封面只认 `sort_order = 0`（#6 契约 §1：下标即 sortOrder，0 才是封面），与 listings
      // feed / matching / 本文件其它查询同一口径（#40/F3）。
      const result = await db.execute(sql`
        SELECT l.id, l.listing_no, l.title, l.price_cents, l.category::text AS category,
               l.condition::text AS condition, l.status::text AS status,
               l.urgent, l.negotiable, l.free, l.created_at,
               (SELECT li.object_key FROM listing_images li
                 WHERE li.listing_id = l.id AND li.sort_order = 0 LIMIT 1)
                 AS cover_object_key
        FROM listings l
        WHERE l.seller_id = ${userId}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map((row) => ({
        id: row.id as string,
        listingNo: BigInt(String(row.listing_no)),
        title: row.title as string,
        priceCents: row.price_cents as number,
        category: row.category as ProfileListingRow['category'],
        condition: row.condition as ProfileListingRow['condition'],
        status: row.status as ProfileListingRow['status'],
        urgent: Boolean(row.urgent),
        negotiable: Boolean(row.negotiable),
        free: Boolean(row.free),
        // 裸 SQL 的时间戳按仓库统一口径写成 `Date | string` 再归一：不靠驱动的返回类型假设。
        createdAt: new Date(row.created_at as string | Date),
        coverObjectKey: (row.cover_object_key as string | null) ?? null,
      }))
    },

    async ownWishes(userId, limit) {
      // 与 #7 的「我的愿望」读模型（wishes/store.ts 的 listForUser）同口径：category / budget
      // 在 DB 里可空（#2 为 #8 预留「不限分类 / 不限预算」），而契约的 WishDto 三者皆非空。
      // 预算为 NULL 是**真实存在**的 shape —— seed 的 wishKeyboard 就只给了 budget_max，
      // 因此把 NULL 归一为 0（与 #7 的 `Number(row.budget_min_cents)` 完全一致），
      // 而不是把用户自己的愿望整行藏起来（那会让同一个用户在 /wishes 看得到、在 /profile
      // 看不到）。只有 category 为 NULL 的行无法表示成 WishDto 的枚举才继续过滤，
      // 而创建接口里 category 必填，该 shape 经 API 不可达。
      const result = await db.execute(sql`
        SELECT w.id, w.user_id, w.keyword, w.category::text AS category,
               w.budget_min_cents, w.budget_max_cents, w.description,
               w.accept_similar, w.status::text AS status, w.created_at, w.updated_at,
               (SELECT count(*)::int FROM matches m WHERE m.wish_id = w.id) AS match_count
        FROM wishes w
        WHERE w.user_id = ${userId}
          AND w.category IS NOT NULL
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map((row) => ({
        id: row.id as string,
        user_id: row.user_id as string,
        keyword: row.keyword as string,
        category: row.category as string,
        // Number(null) === 0：与 #7 读模型的归一方式逐字一致，两接口给出同一个数。
        budget_min_cents: Number(row.budget_min_cents),
        budget_max_cents: Number(row.budget_max_cents),
        description: (row.description as string | null) ?? null,
        accept_similar: Boolean(row.accept_similar),
        status: row.status as string,
        match_count: Number(row.match_count),
        created_at: row.created_at as Date | string,
        updated_at: row.updated_at as Date | string,
      }))
    },

    async ownTransactions(userId, limit) {
      // 买入 + 卖出合并；role 与 counterpart 都由查看者（profile owner）视角判定
      // （buyer_id = me 即买入，对方是 seller，反之亦然——会话/交易的严格双人不变量）。
      // 内嵌摘要直接 join 已冻结的 listings/users 表（本域只读，不调用其他 Domain API）。
      // 封面口径与 ownListings / #6 契约 §1 一致：只有 `sort_order = 0` 才是封面；
      // 取不到 0 号图就返回 null，不能用序号更大的图片顶替。
      const result = await db.execute(sql`
        SELECT t.id, t.listing_id, t.buyer_id, t.amount_cents, t.status::text AS status,
               t.created_at,
               l.title AS listing_title, l.price_cents AS listing_price_cents,
               l.status::text AS listing_status,
               (SELECT li.object_key FROM listing_images li
                 WHERE li.listing_id = t.listing_id AND li.sort_order = 0 LIMIT 1)
                 AS listing_cover_key,
               u.id AS counterpart_id, u.nickname AS counterpart_nickname,
               u.avatar_url AS counterpart_avatar_url
        FROM transactions t
        JOIN listings l ON l.id = t.listing_id
        LEFT JOIN users u ON u.id = (CASE WHEN t.buyer_id = ${userId} THEN t.seller_id ELSE t.buyer_id END)
        WHERE t.buyer_id = ${userId} OR t.seller_id = ${userId}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map((row) => ({
        id: row.id as string,
        listingId: row.listing_id as string,
        buyerId: row.buyer_id as string,
        amountCents: row.amount_cents as number,
        status: row.status as string,
        createdAt: row.created_at as Date | string,
        listing:
          row.listing_title != null
            ? {
                title: row.listing_title as string,
                priceCents: row.listing_price_cents as number,
                status: row.listing_status as string,
                coverObjectKey: (row.listing_cover_key as string | null) ?? null,
              }
            : null,
        counterpart:
          row.counterpart_id != null
            ? {
                id: row.counterpart_id as string,
                nickname: row.counterpart_nickname as string,
                avatarUrl: (row.counterpart_avatar_url as string | null) ?? null,
              }
            : null,
      }))
    },

    async updateUser(userId, patch) {
      // `set(patch)` 的列由调用方决定：空 patch（两个字段都没给）在契约层就被 refine 拦掉了，
      // 走不到这里；drizzle 也不允许 `set({})`。
      const rows = await db.update(users).set(patch).where(eq(users.id, userId)).returning()
      return rows[0] ?? null
    },
  }
}
