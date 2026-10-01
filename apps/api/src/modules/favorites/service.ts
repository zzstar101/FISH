import type {
  FavoriteErrorCode,
  FavoriteItem,
  FavoriteState,
  MyFavoritesQuery,
  MyFavoritesResponse,
} from '@fish/contracts/favorites/schema'
import { MyFavoritesResponseSchema } from '@fish/contracts/favorites/schema'
import type { ApiErrorDetail, SystemErrorCode } from '@fish/contracts/system/error'
import { toListingCard } from '../listings/card'
import type { MediaStorage } from '../uploads/storage'
import { decodeFavoritesCursor, encodeFavoritesCursor } from './cursor'
import type { FavoriteRow, FavoriteStore } from './store'

/**
 * 收藏关系的业务层（Issue #190）。
 *
 * `code` 取值域由契约的 `FavoriteErrorCodeSchema` 收窄（`FavoriteErrorCode`）；
 * `VALIDATION_FAILED` 直接取 system 的成员（不重写字面量），重命名会在这里编译失败。
 */
export class FavoriteServiceError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: FavoriteErrorCode | Extract<SystemErrorCode, 'VALIDATION_FAILED'>,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'FavoriteServiceError'
  }
}

/**
 * 404 只有一个：不存在 / 不可见 / 不在售 / 已被平台下架，四者同码同文案。
 * 这条路径任何登录用户都能稳定触发，区分它们等于给出一份商品 id 空间与治理状态的探针。
 */
const listingNotFound = () =>
  new FavoriteServiceError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')

/** 非法游标 → 422（与 listings feed 同一结论），不做"宽容解析"。 */
const invalidCursor = () =>
  new FavoriteServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])

/**
 * 逐字段组装收藏行（**不是** `{...row}`）：显式列出两个字段，谁想多带一个都得改这行字面量。
 * 卡片交给共享的 `toListingCard`，且**不传**审核态三参数 —— 收藏者是买家视角，
 * 公开投影的 `moderationStatus` / `governanceDelisted` / `moderationReason` 恒为 `null`。
 */
function toFavoriteItem(
  row: FavoriteRow,
  storage: Pick<MediaStorage, 'publicUrl'>,
): FavoriteItem | null {
  const listing = toListingCard(row, row.coverObjectKey, storage)
  if (listing === null) return null
  return { listing, favoritedAt: row.favoritedAt }
}

export interface FavoriteService {
  listMyFavorites(userId: string, query: MyFavoritesQuery): Promise<MyFavoritesResponse>
  getState(userId: string, listingId: string): Promise<FavoriteState>
  favorite(userId: string, listingId: string): Promise<FavoriteState>
  unfavorite(userId: string, listingId: string): Promise<FavoriteState>
}

export function createFavoriteService({
  store,
  storage,
}: {
  store: FavoriteStore
  storage: Pick<MediaStorage, 'publicUrl'>
}): FavoriteService {
  /**
   * **收藏**（POST）的判据：商品存在、在售（`ACTIVE`）、且未被平台下架。
   *
   * 为什么只有收藏要这么严：它问的是「我现在能不能收藏这件东西」，而只有摆在货架上的
   * 商品才有这个语义。已收藏的条目**不因商品状态变化而失效** —— 售出 / 下架之后它仍在
   * 列表里（`facts` 见契约 `FavoriteItemSchema` 的注释），所以读状态与取消收藏用的是
   * 另外两条更宽的判据，见下面两个函数。
   *
   * 刻意的竞态窗口：判定与写入之间不加锁，所以「刚下架的商品被收藏成功」是可能的。
   * 后果只是列表里多一条立刻失效的条目，无数据损坏 —— 不为它引入事务。
   */
  async function requireFavoritableListing(listingId: string): Promise<void> {
    const state = await store.listingState(listingId)
    if (state === null) throw listingNotFound()
    if (state.status !== 'ACTIVE') throw listingNotFound()
    if (state.governanceDelistedAt !== null) throw listingNotFound()
  }

  /**
   * **读收藏态**（GET）的判据：镜像商品详情页的可见性 ——
   * `status !== OFFLINE` 且审核通过，或者是卖家本人（`listings/service.ts` 的 `loadDetail`）。
   *
   * 为什么不沿用 POST 那条：`SOLD` / `RESERVED` 商品的详情页**是公开可读的**
   * （`loadDetail` 只对 `OFFLINE` 与非 `APPROVED` 404），页面上那颗收藏心必须读得到真实状态；
   * 而 `OFFLINE` / 未过审的商品，非卖家连详情页都打不开，这里也不该给出口 ——
   * 否则这条登录可达的路径就成了「某个 id 是否存在且已下架」的探针。
   */
  async function requireVisibleListing(listingId: string, viewerId: string): Promise<void> {
    const state = await store.listingState(listingId)
    if (state === null) throw listingNotFound()
    const invisible = state.status === 'OFFLINE' || state.moderationStatus !== 'APPROVED'
    if (invisible && state.sellerId !== viewerId) throw listingNotFound()
  }

  return {
    async listMyFavorites(userId, query) {
      const cursor = query.cursor === undefined ? null : decodeFavoritesCursor(query.cursor)
      if (query.cursor !== undefined && cursor === null) throw invalidCursor()

      const [rows, total] = await Promise.all([
        store.listFavorites(userId, query.limit, cursor),
        store.totalFavorites(userId),
      ])

      // 多取的那一行决定还有没有下一页，不进响应（与 listings feed 同款）。
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)

      return MyFavoritesResponseSchema.parse({
        // 单行脏数据跳过而不是整页打不开（决策 C，与 #6 冻结口径一致）。
        items: page
          .map((row) => toFavoriteItem(row, storage))
          .filter((item): item is FavoriteItem => item !== null),
        nextCursor:
          hasMore && last
            ? encodeFavoritesCursor({ createdAt: last.favoritedAtCursor, listingId: last.id })
            : null,
        total,
      })
    },

    async getState(userId, listingId) {
      await requireVisibleListing(listingId, userId)
      return { favorited: await store.isFavorited(userId, listingId) }
    },

    async favorite(userId, listingId) {
      await requireFavoritableListing(listingId)
      await store.addFavorite(userId, listingId)
      // 回状态而不是 204：端上直接采用服务端结论，不本地翻转再自己猜。
      return { favorited: true }
    },

    async unfavorite(userId, listingId) {
      // **不判商品状态**：取消收藏是清理一条关系，而失效条目（SOLD / OFFLINE / 被平台下架）
      // 恰恰最需要被清掉 —— 列表里全是取消不掉的条目等于收藏夹只能进不能出。
      // 连商品是否存在也不查：无条件幂等删除既不需要那次读，也不给 id 存在性留探针
      // （`(user_id, listing_id)` 唯一索引让删除天然幂等，删不到就是本来没收藏）。
      await store.removeFavorite(userId, listingId)
      return { favorited: false }
    },
  }
}
