import type { Me } from '@fish/contracts/auth/user'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { ListingFeedResponseSchema } from '@fish/contracts/listings/schema'
import { PROFILE_ROUTES } from '@fish/contracts/profile/routes'
import { type ProfileResponse, profileResponseSchema } from '@fish/contracts/profile/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { transactionListResponseSchema } from '@fish/contracts/transactions/schema'
import { apiRequest } from '../../lib/api-client'

/** 当前登录用户的聚合视图（#12 契约：user + stats + listings/wishes/transactions）。 */
export async function fetchProfile(): Promise<ProfileResponse> {
  return profileResponseSchema.parse(await apiRequest(PROFILE_ROUTES.me))
}

export type ProfileSummary = {
  me: Me
  /** #12 工作项口径「在售/愿望/买入/卖出」。 */
  stats: { active: number; wishes: number; sold: number; bought: number }
  /** 进行中交易（PENDING_MEETUP）。来自聚合交易列表（封顶 100 条内准确）。 */
  orderInProgress: number
  wishCount: number
}

/**
 * 个人中心聚合 → 页面用的摘要。
 * 「买入/卖出」条数由 transactions 按 role 分组得到（契约 stats 刻意不计这两个数）。
 */
export async function fetchProfileSummary(): Promise<ProfileSummary> {
  const profile = await fetchProfile()
  return {
    me: profile.user,
    stats: {
      active: profile.stats.activeListings,
      wishes: profile.stats.activeWishes,
      sold: profile.transactions.filter((item) => item.role === 'seller').length,
      bought: profile.transactions.filter((item) => item.role === 'buyer').length,
    },
    orderInProgress: profile.transactions.filter((item) => item.status === 'PENDING_MEETUP').length,
    wishCount: profile.stats.activeWishes,
  }
}

/** 我的交易（/orders 页）。 */
export async function fetchMyTransactions(role?: 'buyer' | 'seller'): Promise<TransactionDto[]> {
  const query = new URLSearchParams({ limit: '50' })
  if (role) query.set('role', role)
  const payload = await apiRequest(`/transactions?${query.toString()}`)
  return transactionListResponseSchema.parse(payload).items
}

export type MyListingLists = { all: ListingCard[]; active: ListingCard[]; sold: ListingCard[] }

/** 「我发布的 / 在售 / 我卖出的」分页数据：走 #6 的 sellerId 读路径（本人视角含非 ACTIVE）。 */
export async function fetchMyListingLists(meId: string): Promise<MyListingLists> {
  const query = new URLSearchParams({ sellerId: meId, limit: '50' })
  const [all, active, sold] = await Promise.all([
    apiRequest(`/listings?${query.toString()}`),
    apiRequest(`/listings?${query.toString()}&status=ACTIVE`),
    apiRequest(`/listings?${query.toString()}&status=SOLD`),
  ])
  return {
    all: ListingFeedResponseSchema.parse(all).items,
    active: ListingFeedResponseSchema.parse(active).items,
    sold: ListingFeedResponseSchema.parse(sold).items,
  }
}
