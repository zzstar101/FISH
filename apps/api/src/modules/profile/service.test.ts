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
  authStatus: 'VERIFIED',
  verifiedAt: '2026-09-12T00:00:00.000Z',
  phoneBound: false,
  maskedPhone: null,
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
  createdAt: new Date('2026-09-12T01:00:00.000Z'),
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
  listing: {
    title: 'K380 键盘',
    priceCents: 16000,
    status: 'SOLD',
    coverObjectKey: 'covers/tx.jpg',
  },
  counterpart: {
    id: '00000000-0000-4000-8000-0000000000a2',
    nickname: '卖家小王',
    avatarUrl: null,
  },
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
    // 交易：我是 buyer → role=buyer；订单卡摘要内嵌商品与对方（coverUrl 由 storage 拼）
    expect(profile.transactions[0]?.role).toBe('buyer')
    expect(profile.transactions[0]?.listing).toEqual({
      id: listingRow().id,
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'SOLD',
      coverUrl: 'https://cdn.test/covers/tx.jpg',
    })
    expect(profile.transactions[0]?.counterpart).toMatchObject({ nickname: '卖家小王' })
  })

  test('transaction row missing embedded summary is skipped (决策 C)', async () => {
    const store = new MemoryProfileStore()
    store.transactions = [txRow({ listing: null, counterpart: null })]
    const service = createProfileService({ store, storage })
    const profile = await service.getProfile(me)
    expect(profile.transactions).toHaveLength(0)
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

  test('counterpart.avatarUrl 的脏值降级为 null，合法 URL 原样保留', async () => {
    const dirty = new MemoryProfileStore()
    dirty.transactions = [
      txRow({
        counterpart: {
          id: '00000000-0000-4000-8000-0000000000a2',
          nickname: '卖家小王',
          // #2 的 users.avatar_url 是无约束 text：object key 这类历史值不符合契约的 z.url()
          avatarUrl: 'listings/avatar.jpg',
        },
      }),
    ]
    // 修复前：z.url() 解析失败 → 整个聚合抛 ZodError（一个脏字段让 /profile 全打不开）
    const dirtyProfile = await createProfileService({ store: dirty, storage }).getProfile(me)
    expect(dirtyProfile.transactions).toHaveLength(1)
    expect(dirtyProfile.transactions[0]?.counterpart.avatarUrl).toBeNull()

    const clean = new MemoryProfileStore()
    clean.transactions = [
      txRow({
        counterpart: {
          id: '00000000-0000-4000-8000-0000000000a2',
          nickname: '卖家小王',
          avatarUrl: 'https://cdn.test/avatars/a2.jpg',
        },
      }),
    ]
    const cleanProfile = await createProfileService({ store: clean, storage }).getProfile(me)
    expect(cleanProfile.transactions[0]?.counterpart.avatarUrl).toBe(
      'https://cdn.test/avatars/a2.jpg',
    )
  })

  test('null cover renders as null URL', async () => {
    const store = new MemoryProfileStore()
    store.listings = [listingRow({ coverObjectKey: null })]
    const service = createProfileService({ store, storage })
    const profile = await service.getProfile(me)
    expect(profile.listings[0]?.coverUrl).toBeNull()
  })
})
