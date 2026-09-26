import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { UserRow } from '../auth/me'
import type { UploadService } from '../uploads/service'
import type { MediaStorage } from '../uploads/storage'
import { createProfileService, PROFILE_LIST_LIMIT } from './service'
import type {
  ProfileListingRow,
  ProfileStatsRow,
  ProfileStore,
  ProfileTransactionRow,
  ProfileWishRow,
} from './store'

const USER_ID = '01930000-0000-7000-8000-0000000000a1'
const me: Me = {
  id: encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
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

/**
 * #86 B：改头像必须复用上传域的 `confirm`（归属前缀 + 对象已上传 + 格式/大小）。
 * 读用例不碰它；写用例要断言「服务端拼的是 confirm 给的 URL，而不是端上给的字符串」，
 * 所以这里给一个能记录调用的假实现（真实现要求 storage.stat 有对象，本文件不搭 S3）。
 */
function fakeUploads(): Pick<UploadService, 'confirm'> & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async confirm(_userId, input) {
      calls.push(input.objectKey)
      return { objectKey: input.objectKey, url: `https://cdn.test/${input.objectKey}` }
    },
  }
}

/** `users` 行 fixture：写用例要断言 DB 行 → Me 的映射仍走认证域的 toMe。 */
const userRow = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: USER_ID,
  studentNo: null,
  passwordHash: null,
  nickname: '小明',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  verifiedAt: new Date('2026-09-12T00:00:00.000Z'),
  campusEmail: null,
  phone: null,
  role: 'USER',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-12T00:00:00.000Z'),
  ...overrides,
})

const listingRow = (overrides: Partial<ProfileListingRow> = {}): ProfileListingRow => ({
  id: '01930000-0000-7000-8000-0000000000b1',
  listingNo: 123456789012n,
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
  id: '01930000-0000-7000-8000-0000000000d1',
  user_id: USER_ID,
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
  id: '01930000-0000-7000-8000-0000000000e1',
  listingId: listingRow().id,
  buyerId: USER_ID, // 我是买家 → role=buyer
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
    id: '01930000-0000-7000-8000-0000000000a2',
    nickname: '卖家小王',
    avatarUrl: null,
  },
  ...overrides,
})

class MemoryProfileStore implements ProfileStore {
  statsRow: ProfileStatsRow = { activeListings: 1, activeWishes: 1, completedTransactions: 1 }
  lastStatsUserId: string | null = null
  listings: ProfileListingRow[] = [listingRow()]
  wishes: ProfileWishRow[] = [wishRow()]
  transactions: ProfileTransactionRow[] = [txRow()]
  /** `updateUser` 收到的最后一次写入（写用例断言「只写了该写的列」）。 */
  updated: { userId: string; patch: { nickname?: string; avatarUrl?: string } } | null = null
  /** 覆盖 `updateUser` 的返回行；null 模拟「认证与写入之间账号被删」。 */
  updateResult: UserRow | null | undefined = undefined

  async stats(userId: string): Promise<ProfileStatsRow> {
    this.lastStatsUserId = userId
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
  async updateUser(userId: string, patch: { nickname?: string; avatarUrl?: string }) {
    this.updated = { userId, patch }
    if (this.updateResult !== undefined) return this.updateResult
    return userRow({ id: userId, ...patch })
  }
}

/** 读用例的统一装配（#86 B 起 createProfileService 多一个必填的 uploads 依赖）。 */
const createService = (
  store: ProfileStore,
  uploads: Pick<UploadService, 'confirm'> = fakeUploads(),
) => createProfileService({ store, storage, uploads })

describe('profile service: getProfile', () => {
  test('aggregates user + stats + three lists in one call', async () => {
    const store = new MemoryProfileStore()
    const service = createService(store)
    const profile = await service.getProfile(me)

    expect(store.lastStatsUserId).toBe(USER_ID)
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
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, listingRow().id),
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
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.transactions).toHaveLength(0)
  })

  test('transaction role is seller when I am not the buyer', async () => {
    const store = new MemoryProfileStore()
    store.transactions = [txRow({ buyerId: '01930000-0000-7000-8000-0000000000a2' })]
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.transactions[0]?.role).toBe('seller')
  })

  test('limit is applied to each list (封顶 100)', async () => {
    const store = new MemoryProfileStore()
    store.listings = Array.from({ length: PROFILE_LIST_LIMIT + 10 }, (_, i) =>
      listingRow({ id: `01930000-0000-7000-8000-${String(i + 1).padStart(12, '0')}` }),
    )
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.listings).toHaveLength(PROFILE_LIST_LIMIT)
  })

  test('counterpart.avatarUrl 的脏值降级为 null，合法 URL 原样保留', async () => {
    const dirty = new MemoryProfileStore()
    dirty.transactions = [
      txRow({
        counterpart: {
          id: '01930000-0000-7000-8000-0000000000a2',
          nickname: '卖家小王',
          // #2 的 users.avatar_url 是无约束 text：object key 这类历史值不符合契约的 z.url()
          avatarUrl: 'listings/avatar.jpg',
        },
      }),
    ]
    // 修复前：z.url() 解析失败 → 整个聚合抛 ZodError（一个脏字段让 /profile 全打不开）
    const dirtyProfile = await createService(dirty).getProfile(me)
    expect(dirtyProfile.transactions).toHaveLength(1)
    expect(dirtyProfile.transactions[0]?.counterpart.avatarUrl).toBeNull()

    const clean = new MemoryProfileStore()
    clean.transactions = [
      txRow({
        counterpart: {
          id: '01930000-0000-7000-8000-0000000000a2',
          nickname: '卖家小王',
          avatarUrl: 'https://cdn.test/avatars/a2.jpg',
        },
      }),
    ]
    const cleanProfile = await createService(clean).getProfile(me)
    expect(cleanProfile.transactions[0]?.counterpart.avatarUrl).toBe(
      'https://cdn.test/avatars/a2.jpg',
    )
  })

  test('null cover renders as null URL', async () => {
    const store = new MemoryProfileStore()
    store.listings = [listingRow({ coverObjectKey: null })]
    const service = createService(store)
    const profile = await service.getProfile(me)
    expect(profile.listings[0]?.coverUrl).toBeNull()
  })
})

describe('profile service: updateProfile（#86 B：编辑资料）', () => {
  test('只改昵称：只写 nickname 一列，不碰头像、不碰上传域', async () => {
    const store = new MemoryProfileStore()
    const uploads = fakeUploads()
    const user = await createService(store, uploads).updateProfile(me, { nickname: '新名字' })

    expect(store.updated).toEqual({ userId: USER_ID, patch: { nickname: '新名字' } })
    expect(uploads.calls).toEqual([])
    expect(user.nickname).toBe('新名字')
    expect(user.avatarUrl).toBeNull()
  })

  test('只改头像：objectKey 交给上传域 confirm，落库的是它给的绝对 URL', async () => {
    const store = new MemoryProfileStore()
    const uploads = fakeUploads()
    const user = await createService(store, uploads).updateProfile(me, {
      avatarObjectKey: 'listings/u1/a.jpg',
    })

    expect(uploads.calls).toEqual(['listings/u1/a.jpg'])
    expect(store.updated?.patch).toEqual({ avatarUrl: 'https://cdn.test/listings/u1/a.jpg' })
    expect(user.avatarUrl).toBe('https://cdn.test/listings/u1/a.jpg')
  })

  test('两项一起改：一次 update 同时落 nickname 与 avatarUrl', async () => {
    const store = new MemoryProfileStore()
    const user = await createService(store).updateProfile(me, {
      nickname: '新名字',
      avatarObjectKey: 'listings/u1/a.jpg',
    })

    expect(store.updated?.patch).toEqual({
      nickname: '新名字',
      avatarUrl: 'https://cdn.test/listings/u1/a.jpg',
    })
    expect(user).toMatchObject({
      id: me.id,
      nickname: '新名字',
      avatarUrl: 'https://cdn.test/listings/u1/a.jpg',
    })
  })

  test('写入与认证之间账号被删：updateUser 回 null 时抛错，不返回假 Me', async () => {
    const store = new MemoryProfileStore()
    store.updateResult = null

    await expect(createService(store).updateProfile(me, { nickname: '新名字' })).rejects.toThrow(
      '更新资料时账号已不存在',
    )
  })

  test('上传域拒绝（不属于本人 / 对象缺失 / 格式大小）原样冒泡，不写库', async () => {
    const store = new MemoryProfileStore()
    const rejected: Pick<UploadService, 'confirm'> = {
      confirm: async () => {
        throw new Error('IMAGE_REFERENCE_INVALID')
      },
    }

    await expect(
      createService(store, rejected).updateProfile(me, { avatarObjectKey: 'listings/u2/b.jpg' }),
    ).rejects.toThrow('IMAGE_REFERENCE_INVALID')
    expect(store.updated).toBeNull()
  })
})
