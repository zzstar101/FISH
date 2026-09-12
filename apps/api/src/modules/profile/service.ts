import type { Me } from '@fish/contracts/auth/user'
import { type ProfileResponse, profileResponseSchema } from '@fish/contracts/profile/schema'
import { wishDtoSchema } from '@fish/contracts/wishes/schema'
import { toListingCard } from '../listings/card'
import type { MediaStorage } from '../uploads/storage'
import { toWishDto } from '../wishes/service'
import type { ProfileStore, ProfileTransactionRow } from './store'

/** 各列表的服务端封顶（契约注释冻结：P0 不分页，超出再扩游标端点）。 */
export const PROFILE_LIST_LIMIT = 100

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
        // 决策 C（#6 冻结口径）：单行脏数据记日志跳过，不让整个 /profile 打不开。
        listings: listingRows
          .map((row) => toListingCard(row, row.coverObjectKey, storage))
          .filter((card) => card !== null),
        wishes: wishRows.flatMap((row) => {
          const parsed = wishDtoSchema.safeParse(toWishDto(row))
          if (!parsed.success) {
            console.error('[profile] 跳过无法映射为契约的愿望', row.id, parsed.error.message)
            return []
          }
          return [parsed.data]
        }),
        transactions: txRows.map((row) => toProfileTransaction(row, me.id)),
      })
    },
  }
}
