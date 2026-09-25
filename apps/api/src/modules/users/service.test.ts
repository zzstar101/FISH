import { describe, expect, setSystemTime, test } from 'bun:test'
import { decodeCursor, encodeCursor } from '../listings/cursor'
import { createPublicUserService, PublicUserServiceError } from './service'
import type {
  PublicListingCursor,
  PublicListingRow,
  PublicUserRow,
  PublicUserStatsRow,
  PublicUserStore,
} from './store'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const OTHER_ID = '01930000-0000-7000-8000-00000000000b'
const LISTING_A = '01930000-0000-7000-8000-000000000011'
const LISTING_B = '01930000-0000-7000-8000-000000000012'
const LISTING_C = '01930000-0000-7000-8000-000000000013'

const storage = { publicUrl: (objectKey: string) => `https://cdn.test/${objectKey}` }

function userRow(overrides: Partial<PublicUserRow> = {}): PublicUserRow {
  return {
    id: USER_ID,
    nickname: '林一',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

function listingRow(overrides: Partial<PublicListingRow> = {}): PublicListingRow {
  return {
    id: LISTING_A,
    listingNo: 123456789012n,
    title: '二手台灯',
    priceCents: 3000,
    category: 'DAILY',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    createdAt: new Date('2026-09-10T02:00:00.000Z'),
    createdAtCursor: '2026-09-10T02:00:00.000000Z',
    coverObjectKey: null,
    ...overrides,
  }
}

/** 只实现 service 用到的行为，并记录调用参数以便断言。 */
function fakeStore(
  options: {
    user?: PublicUserRow | null
    stats?: Partial<PublicUserStatsRow>
    listings?: PublicListingRow[]
  } = {},
): PublicUserStore & {
  listCalls: { userId: string; limit: number; cursor: PublicListingCursor | null }[]
} {
  const listCalls: { userId: string; limit: number; cursor: PublicListingCursor | null }[] = []
  const rows = options.listings ?? []
  const user = options.user === undefined ? userRow() : options.user

  return {
    listCalls,
    async findPublicUser(userId) {
      return user !== null && user.id === userId ? user : null
    },
    async stats() {
      return { activeListings: 3, soldCount: 1, ...options.stats }
    },
    async listActiveListings(userId, limit, cursor) {
      listCalls.push({ userId, limit, cursor })
      // store 约定：多取一行让调用方判断 hasMore。
      return rows.slice(0, limit + 1)
    },
  }
}

function service(store: PublicUserStore) {
  return createPublicUserService({ store, storage })
}

/** 捕捉抛出的 PublicUserServiceError，断言不成立时给出可读失败。 */
function catchError(error: unknown): PublicUserServiceError {
  if (!(error instanceof PublicUserServiceError)) throw error
  return error
}

describe('公开资料', () => {
  test('DTO 的键集合恰好是契约里的七个字段（不多一个）', async () => {
    const profile = await service(fakeStore()).getPublicProfile(USER_ID)

    expect(Object.keys(profile).sort()).toEqual([
      'activeCount',
      'authStatus',
      'avatarUrl',
      'id',
      'joinedDays',
      'nickname',
      'soldCount',
    ])
  })

  test('把统计与加入天数一起组装进响应', async () => {
    setSystemTime(new Date('2026-09-20T00:00:00.000Z'))
    try {
      const profile = await service(
        fakeStore({ stats: { activeListings: 7, soldCount: 2 } }),
      ).getPublicProfile(USER_ID)

      // 2026-09-01 → 2026-09-20 共 19 天。
      expect(profile.joinedDays).toBe(19)
      expect(profile.activeCount).toBe(7)
      expect(profile.soldCount).toBe(2)
    } finally {
      setSystemTime()
    }
  })

  test('注册当天是「加入 1 天」而不是 0 天', async () => {
    setSystemTime(new Date('2026-09-01T05:00:00.000Z'))
    try {
      const profile = await service(fakeStore()).getPublicProfile(USER_ID)
      expect(profile.joinedDays).toBe(1)
    } finally {
      setSystemTime()
    }
  })

  test('头像脏值降级为 null，不把整页打成 500', async () => {
    const profile = await service(
      fakeStore({ user: userRow({ avatarUrl: 'not-a-url' }) }),
    ).getPublicProfile(USER_ID)

    expect(profile.avatarUrl).toBeNull()
  })

  test('不存在的用户 → 404 USER_NOT_FOUND', async () => {
    try {
      await service(fakeStore()).getPublicProfile(OTHER_ID)
      throw new Error('应当抛错')
    } catch (error) {
      const err = catchError(error)
      expect(err.status).toBe(404)
      expect(err.code).toBe('USER_NOT_FOUND')
    }
  })
})

describe('在售列表', () => {
  test('把 limit 与解码后的游标交给 store', async () => {
    const store = fakeStore()
    await service(store).listActiveListings(USER_ID, {
      limit: 5,
      cursor: encodeCursor({ sortKey: '2026-09-10T02:00:00.000000Z', id: LISTING_A }),
    })

    expect(store.listCalls).toEqual([
      {
        userId: USER_ID,
        limit: 5,
        cursor: { createdAt: '2026-09-10T02:00:00.000000Z', id: LISTING_A },
      },
    ])
  })

  test('不存在的用户 → 404，且**不查**列表（不能对不存在的人返回空列表）', async () => {
    const store = fakeStore()
    await expect(service(store).listActiveListings(OTHER_ID, { limit: 20 })).rejects.toBeInstanceOf(
      PublicUserServiceError,
    )

    expect(store.listCalls).toEqual([])
  })

  test('非法游标 → 422 VALIDATION_FAILED（details 指向 cursor），且不查列表', async () => {
    const store = fakeStore()
    try {
      await service(store).listActiveListings(USER_ID, { limit: 20, cursor: 'not-a-cursor' })
      throw new Error('应当抛错')
    } catch (error) {
      const err = catchError(error)
      expect(err.status).toBe(422)
      expect(err.code).toBe('VALIDATION_FAILED')
      expect(err.details).toEqual([{ field: 'cursor', message: 'cursor 无效' }])
    }

    expect(store.listCalls).toEqual([])
  })

  test('游标里的 sortKey 必须是微秒时间戳形态（否则同样是 422，不打到 PG）', async () => {
    const store = fakeStore()
    // 形状合法但值域非法：手写正则放得过，`::timestamptz` 会拒。
    const bad = encodeCursor({ sortKey: '2026-13-45T99:99:99.999999Z', id: LISTING_A })
    await expect(
      service(store).listActiveListings(USER_ID, { limit: 20, cursor: bad }),
    ).rejects.toBeInstanceOf(PublicUserServiceError)
    expect(store.listCalls).toEqual([])
  })

  test('还有下一页时 nextCursor 指向**最后一条已返回**的行', async () => {
    const store = fakeStore({
      listings: [
        listingRow({ id: LISTING_A, createdAtCursor: '2026-09-10T02:00:00.000000Z' }),
        listingRow({ id: LISTING_B, createdAtCursor: '2026-09-09T02:00:00.000000Z' }),
        listingRow({ id: LISTING_C, createdAtCursor: '2026-09-08T02:00:00.000000Z' }),
      ],
    })

    const page = await service(store).listActiveListings(USER_ID, { limit: 2 })

    expect(page.items.map((item) => item.id)).toEqual([LISTING_A, LISTING_B])
    expect(page.nextCursor).not.toBeNull()
    expect(decodeCursor(page.nextCursor as string)).toEqual({
      sortKey: '2026-09-09T02:00:00.000000Z',
      id: LISTING_B,
    })
  })

  test('最后一页的 nextCursor 是 null', async () => {
    const store = fakeStore({ listings: [listingRow()] })
    const page = await service(store).listActiveListings(USER_ID, { limit: 2 })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.listingNo).toBe('123456789012')
    expect(page.nextCursor).toBeNull()
  })

  test('封面走 storage 拼 URL，无图商品是 null', async () => {
    const store = fakeStore({
      listings: [
        listingRow({ id: LISTING_A, coverObjectKey: 'listings/a.jpg' }),
        listingRow({ id: LISTING_B, coverObjectKey: null }),
      ],
    })

    const page = await service(store).listActiveListings(USER_ID, { limit: 20 })

    expect(page.items[0]?.coverUrl).toBe('https://cdn.test/listings/a.jpg')
    expect(page.items[1]?.coverUrl).toBeNull()
  })
})
