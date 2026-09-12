import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { MediaStorage } from '../uploads/storage'
import { createProfileService, PROFILE_LIST_LIMIT } from './service'
import type {
  ProfileListingRow,
  ProfileStatsRow,
  ProfileStore,
  ProfileTransactionRow,
  ProfileWishRow,
} from './store'

const me: Me = {
  id: '00000000-0000-4000-8000-0000000000a1',
  nickname: '小明',
  avatarUrl: null,
  campus: '肇庆',
  authStatus: 'VERIFIED',
  verifiedAt: '2026-09-12T00:00:00.000Z',
}

const storage: MediaStorage = {
  presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
  stat: async () => null,
  publicUrl: (key) => `https://cdn.test/${key}`,
}

const listingRow = (overrides: Partial<ProfileListingRow> = {}): ProfileListingRow => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  title: 'K380',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  status: 'OFFLINE', // 本人视角可见非在售
  urgent: false,
  negotiable: true,
  free: false,
  createdAt: '2026-09-12T01:00:00.000Z',
  coverObjectKey: 'covers/a.jpg',
  ...overrides,
})

const wishRow = (overrides: Partial<ProfileWishRow> = {}): ProfileWishRow => ({
  id: '00000000-0000-4000-8000-0000000000d1',
  user_id: me.id,
  keyword: '机械键盘',
  category: 'DIGITAL',
  budget_min_cents: 10000,
  budget_max_cents: 20000,
  description: null,
  accept_similar: true,
  status: 'ACTIVE',
  match_count: 2,
  created_at: '2026-09-12T02:00:00.000Z',
  updated_at: '2026-09-12T02:00:00.000Z',
  ...overrides,
})

const txRow = (overrides: Partial<ProfileTransactionRow> = {}): ProfileTransactionRow => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  listingId: listingRow().id,
  buyerId: me.id, // 我是买家 → role=buyer
  amountCents: 15000,
  status: 'COMPLETED',
  createdAt: '2026-09-12T03:00:00.000Z',
  ...overrides,
})

class MemoryProfileStore implements ProfileStore {
  statsRow: ProfileStatsRow = { activeListings: 1, activeWishes: 1, completedTransactions: 1 }
  listings: ProfileListingRow[] = [listingRow()]
  wishes: ProfileWishRow[] = [wishRow()]
  transactions: ProfileTransactionRow[] = [txRow()]

  async stats(): Promise<ProfileStatsRow> {
    return this.statsRow
  }
  async ownListings(_userId: string, limit: number) {
    return this.listings.slice(0, limit)
  }
  async ownWishes(_userId: string, limit: number) {
    return this.wishes.slice(0, limit)
  }
  async ownTransactions(_userId: string, limit: number) {
    return this.transactions.slice(0, limit)
  }
}

describe('profile service: getProfile', () => {
  test('aggregates user + stats + three lists in one call', async () => {
    const service = createProfileService({ store: new MemoryProfileStore(), storage })
    const profile = await service.getProfile(me)

    expect(profile.user).toEqual(me) // user 块原样来自 requireAuth 的 Me
    expect(profile.stats).toEqual({ activeListings: 1, activeWishes: 1, completedTransactions: 1 })
    // 商品卡：封面 objectKey 经 storage 拼 URL；本人可见 OFFLINE
    expect(profile.listings[0]?.coverUrl).toBe('https://cdn.test/covers/a.jpg')
    expect(profile.listings[0]?.status).toBe('OFFLINE')
    // 愿望：snake_case 行经 wishes 模块同一映射函数转 DTO
    expect(profile.wishes[0]?.matchCount).toBe(2)
    expect(profile.wishes[0]?.keyword).toBe('机械键盘')
    // 交易：我是 buyer → role=buyer
    expect(profile.transactions[0]?.role).toBe('buyer')
  })

  test('transaction role is seller when I am not the buyer', async () => {
    const store = new MemoryProfileStore()
    store.transactions = [txRow({ buyerId: '00000000-0000-4000-8000-0000000000a2' })]
    const service = createProfileService({ store, storage })
    const profile = await service.getProfile(me)
    expect(profile.transactions[0]?.role).toBe('seller')
  })

  test('limit is applied to each list (封顶 100)', async () => {
    const store = new MemoryProfileStore()
    store.listings = Array.from({ length: PROFILE_LIST_LIMIT + 10 }, (_, i) =>
      listingRow({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` }),
    )
    const service = createProfileService({ store, storage })
    const profile = await service.getProfile(me)
    expect(profile.listings).toHaveLength(PROFILE_LIST_LIMIT)
  })

  test('null cover renders as null URL', async () => {
    const store = new MemoryProfileStore()
    store.listings = [listingRow({ coverObjectKey: null })]
    const service = createProfileService({ store, storage })
    const profile = await service.getProfile(me)
    expect(profile.listings[0]?.coverUrl).toBeNull()
  })
})
