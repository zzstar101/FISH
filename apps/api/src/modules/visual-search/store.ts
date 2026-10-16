import type { ListingCategory } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { listingViewsCount } from '@fish/db/listing-views'
import { listingWantsCount } from '@fish/db/listing-wants'
import { favorites } from '@fish/db/schema/favorites'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { listingVisualEmbeddings } from '@fish/db/schema/visual-embeddings'
import {
  topKSimilarListingsByVisual,
  type VisualSimilarCandidate,
} from '@fish/db/visual-embedding-store'
import {
  findUsableVisualQueryImage,
  type InsertVisualQueryImageInput,
  insertVisualQueryImage,
  markVisualQueryImageUsed,
  type VisualQueryImageRow,
} from '@fish/db/visual-query-store'
import { and, eq, inArray, ne, type SQL, sql } from 'drizzle-orm'
import type { ListingCardSource } from '../listings/card'

/**
 * 拍照识图搜索的数据访问层（#324 M4）。
 *
 * 这一层只做两件事：查库、把库里的形状翻译成上层要用的形状。可见性过滤在这里**统一收口**
 * （`publicListingVisibility()`），不让 service 各自拼谓词——漏一处的后果是把未过审/已下架的商品
 * 暴露在公开搜索里，这种错误必须在只有一个地方可犯。
 */

/**
 * 公开搜索的可见性谓词。
 *
 * 与 `apps/api/src/modules/listings/store.ts` 的公开 feed 同一口径（`status='ACTIVE'`
 * 且 `moderation_status='APPROVED'`），刻意**不**复用 `listFeed` 本身：那是 #286 的列表查询，
 * 带分页游标、排序、文本搜索等一堆这里不需要的东西，包一层只会让"视觉召回为什么要管这些"
 * 变成新的困惑。口径一致靠这条注释与两处常量对齐来保证。
 *
 * 注意：召回侧过滤 ≠ 生成侧过滤。worker 的 `VISUAL_EMBED_LISTING` handler 会给**所有**存在的
 * 商品建向量（包括未过审的），可见性只在这里把关——这样审核状态变化后不必重算向量。
 */
function publicListingVisibility() {
  return and(eq(listings.status, 'ACTIVE'), publicModerationVisibility())
}

/**
 * 公开可见的**审核态**谓词（与 `status` 正交）：召回与成交均价统计共用同一份。
 *
 * 抽出来是因为两者的 `status` 口径**必然**不同（召回 `ACTIVE`、成交统计 `SOLD`），
 * 而审核态必须逐条一致。如果各写一遍，迟早会出现"能被搜到但不计入均价"（或反之）的商品，
 * 这种漂移不会有任何测试报警——它只是让统计数字悄悄偏掉。
 */
function publicModerationVisibility() {
  return eq(listings.moderationStatus, 'APPROVED')
}

/**
 * 「不返回本人商品」（#324 验收）。
 *
 * 只在**已登录** Caller 上生效：匿名会话的 `subject_key` 是 HMAC 摘要，与任何 `seller_id`
 * 都不可能相等，把它当排除目标既无意义又是在拿一个不该参与业务比较的值做查询。
 * 因此匿名传 `null`/`undefined`，谓词整体缺席（返回 `undefined`，而不是恒真条件）。
 *
 * `ne()` 走绑定参数，不做字符串拼接；与可见性谓词一样拼进召回查询的 WHERE，
 * 保证 Top-K 是**过滤后**的 K 条，而不是被自家商品挤掉名额后再截断。
 */
function excludeOwnListings(excludeSellerId: string | null | undefined): SQL | undefined {
  return excludeSellerId ? ne(listings.sellerId, excludeSellerId) : undefined
}

export type VisualSearchCandidate = {
  listingId: string
  /** 到查询向量的 cosine 距离（`<=>`，越小越像）。 */
  distance: number
}

export type VisualListingSignals = {
  listingId: string
  coverObjectKey: string | null
  favoriteCount: number
}

export type VisualSoldPriceStats = {
  /** 已成交商品的均价（分）；没有样本时为 `null`。四舍五入与最小样本阈值判定在 service 层。 */
  soldAvgPriceCents: number | null
  soldSampleCount: number
}

export type VisualSearchStore = {
  registerQueryImage(input: InsertVisualQueryImageInput): Promise<void>
  findUsableQueryImage(input: {
    objectKey: string
    subjectType: 'user' | 'session'
    subjectKey: string
    now: Date
  }): Promise<VisualQueryImageRow | null>
  markQueryImageUsed(objectKey: string): Promise<boolean>
  /**
   * 按向量召回（已套公开可见性过滤）。
   *
   * `excludeSellerId` = 本次请求者自己的 userId：登录时按验收「不返回本人商品」排除自己发布的
   * 商品；匿名传 `null`（没有可排除的主体）。
   */
  recall(input: {
    model: string
    vector: number[]
    limit: number
    excludeSellerId?: string | null
  }): Promise<VisualSearchCandidate[]>
  /** 库里是否**存在任何**该模型的视觉向量（用于区分"还没回填"与"确实没有相似商品"）。 */
  hasVisualEmbeddings(model: string): Promise<boolean>
  /** 批量取排序所需的信号：封面键与收藏数。 */
  loadListingSignals(listingIds: string[]): Promise<Map<string, VisualListingSignals>>
  /** 批量取卡片所需的商品列（已再套一次可见性过滤，见实现注释）。 */
  loadListings(listingIds: string[]): Promise<Map<string, ListingCardSource>>
  /**
   * 解析出的类目下已成交商品的均价与样本数（#324 M6）。
   *
   * 口径：`status = 'SOLD'` 的 `priceCents` 平均，**不走 transactions 表、不加时间窗口**。
   * 可见性谓词与召回共用 `publicModerationVisibility()`，只把 `status` 从 `ACTIVE` 换成 `SOLD`；
   * `excludeSellerId` 同样与召回共用 `excludeOwnListings()`（#406 第 2 项）——
   * 搜索者**自己**已成交的商品算进"这个类目大概卖多少钱"里，是把本人的成交价混进了他正在
   * 参考的市场行情，与召回侧"不返回本人商品"也是同一口径。
   */
  soldPriceStats(input: {
    category: ListingCategory
    /** 本次请求者自己的 userId；匿名传 `null`/省略（同上，没有可排除的主体）。 */
    excludeSellerId?: string | null
  }): Promise<VisualSoldPriceStats>
}

export function createVisualSearchStore(db: Db): VisualSearchStore {
  return {
    async registerQueryImage(input) {
      await insertVisualQueryImage(db, input)
    },

    async findUsableQueryImage(input) {
      return findUsableVisualQueryImage(db, input)
    },

    async markQueryImageUsed(objectKey) {
      return markVisualQueryImageUsed(db, objectKey)
    },

    async recall(input) {
      const rows: VisualSimilarCandidate[] = await topKSimilarListingsByVisual(db, {
        model: input.model,
        vector: input.vector,
        limit: input.limit,
        filter: and(publicListingVisibility(), excludeOwnListings(input.excludeSellerId)),
      })
      return rows.map((row) => ({ listingId: row.id, distance: row.distance }))
    },

    async hasVisualEmbeddings(model) {
      // 只要一行：`limit(1)` + 空数组判定比 `count(*)` 便宜（不必扫完整个索引）。
      const rows = await db
        .select({ id: listingVisualEmbeddings.id })
        .from(listingVisualEmbeddings)
        .where(eq(listingVisualEmbeddings.model, model))
        .limit(1)
      return rows.length > 0
    },

    async loadListingSignals(listingIds) {
      const signals = new Map<string, VisualListingSignals>()
      if (listingIds.length === 0) return signals

      // 封面与收藏数各查一次（一页最多 30 条），比让主查询带出两处行放大的 join 便宜。
      const covers = await db
        .select({ listingId: listingImages.listingId, objectKey: listingImages.objectKey })
        .from(listingImages)
        .where(and(inArray(listingImages.listingId, listingIds), eq(listingImages.sortOrder, 0)))
      const coverByListing = new Map(covers.map((cover) => [cover.listingId, cover.objectKey]))

      const favoriteRows = await db
        .select({ listingId: favorites.listingId, count: sql<number>`count(*)::int` })
        .from(favorites)
        .where(inArray(favorites.listingId, listingIds))
        .groupBy(favorites.listingId)
      const favoriteByListing = new Map(
        favoriteRows.map((row) => [row.listingId, Number(row.count)]),
      )

      for (const listingId of listingIds) {
        signals.set(listingId, {
          listingId,
          coverObjectKey: coverByListing.get(listingId) ?? null,
          favoriteCount: favoriteByListing.get(listingId) ?? 0,
        })
      }
      return signals
    },

    async loadListings(listingIds) {
      const result = new Map<string, ListingCardSource>()
      if (listingIds.length === 0) return result

      // 可见性**再判一次**：召回与取卡片之间隔着一次向量化调用（可能是一秒级），
      // 期间卖家完全可能把商品下架/编辑到重新待审。召回时过滤过不代表现在仍然可见。
      // innerJoin users（#344）：卡片必须带卖家公开子集，与公开 feed / 详情同一口径；
      // `seller_id` 外键保证行存在，PK join 是 1:1，不影响召回与取卡片。
      const rows = await db
        .select({
          id: listings.id,
          listingNo: listings.listingNo,
          title: listings.title,
          priceCents: listings.priceCents,
          category: listings.category,
          condition: listings.condition,
          status: listings.status,
          urgent: listings.urgent,
          negotiable: listings.negotiable,
          free: listings.free,
          createdAt: listings.createdAt,
          // 想要数（= 已建会话的买家数）：卡片契约的必填字段，主查询一次算完（见 `@fish/db/listing-wants`）。
          // 与同页的 `favoriteCount`（收藏数，识图结果的外挂字段）是**两个不同的量**，别混。
          wants: listingWantsCount(listings.id),
          // 浏览量（近 30 天去重浏览人数）：与「想要数」并排画，同一取舍主查询一次算完。
          views: listingViewsCount(listings.id),
          seller: {
            id: users.id,
            nickname: users.nickname,
            avatarUrl: users.avatarUrl,
            authStatus: users.authStatus,
          },
        })
        .from(listings)
        .innerJoin(users, eq(users.id, listings.sellerId))
        .where(and(inArray(listings.id, listingIds), publicListingVisibility()))

      for (const row of rows) result.set(row.id, row)
      return result
    },

    async soldPriceStats(input) {
      // `avg(...)::float8`：`avg(integer)` 在 PG 里是 `numeric`，Bun 的 SQL 驱动会把它映射成
      // **字符串**（保精度），下游 `Math.round` 会得到 NaN。统计口径只到"分"，float8 足够。
      const rows = await db
        .select({
          soldAvgPriceCents: sql<number | null>`avg(${listings.priceCents})::float8`,
          soldSampleCount: sql<number>`count(*)::int`,
        })
        .from(listings)
        .where(
          and(
            eq(listings.category, input.category),
            eq(listings.status, 'SOLD'),
            publicModerationVisibility(),
            // 与召回侧同一个谓词函数：统计口径与"能不能被本人搜到"不能各写一遍。
            excludeOwnListings(input.excludeSellerId),
          ),
        )

      const row = rows[0]
      return {
        soldAvgPriceCents:
          row?.soldAvgPriceCents === null || row?.soldAvgPriceCents === undefined
            ? null
            : Number(row.soldAvgPriceCents),
        soldSampleCount: Number(row?.soldSampleCount ?? 0),
      }
    },
  }
}
