import type { Me } from '@fish/contracts/auth/user'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { type ProfileResponse, profileResponseSchema } from '@fish/contracts/profile/schema'
import type { MediaStorage } from '../uploads/storage'
import { toWishDto } from '../wishes/service'
import type { WishRow } from '../wishes/store'
import type { ProfileListingRow, ProfileStore, ProfileTransactionRow } from './store'

/** 各列表的服务端封顶（契约注释冻结：P0 不分页，超出再扩游标端点）。 */
export const PROFILE_LIST_LIMIT = 100

/** listings 表行 → #6 的商品卡（本人视角）。枚举/形状由外层 profileResponseSchema.parse 收窄。 */
function toListingCard(row: ProfileListingRow, storage: MediaStorage): ListingCard {
  return {
    id: row.id,
    title: row.title,
    priceCents: row.priceCents,
    category: row.category as ListingCard['category'],
    condition: row.condition as ListingCard['condition'],
    status: row.status as ListingCard['status'],
    urgent: row.urgent,
    negotiable: row.negotiable,
    free: row.free,
    coverUrl: row.coverObjectKey ? storage.publicUrl(row.coverObjectKey) : null,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

function toProfileTransaction(row: ProfileTransactionRow, viewerId: string) {
  return {
    id: row.id,
    listingId: row.listingId,
    role: row.buyerId === viewerId ? ('buyer' as const) : ('seller' as const),
    amountCents: row.amountCents,
    status: row.status as 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED',
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

export interface ProfileService {
  /** 单个聚合接口（Issue #12 的 Backend Done 口径）：一个调用返回个人中心全部读数据。 */
  getProfile(me: Me): Promise<ProfileResponse>
}

export function createProfileService({
  store,
  storage,
}: {
  store: ProfileStore
  storage: MediaStorage
}): ProfileService {
  return {
    async getProfile(me) {
      const [stats, listingRows, wishRows, txRows] = await Promise.all([
        store.stats(me.id),
        store.ownListings(me.id, PROFILE_LIST_LIMIT),
        store.ownWishes(me.id, PROFILE_LIST_LIMIT),
        store.ownTransactions(me.id, PROFILE_LIST_LIMIT),
      ])

      return profileResponseSchema.parse({
        user: me,
        stats,
        listings: listingRows.map((row) => toListingCard(row, storage)),
        wishes: wishRows.map((row) => toWishDto(row as WishRow)),
        transactions: txRows.map((row) => toProfileTransaction(row, me.id)),
      })
    },
  }
}
