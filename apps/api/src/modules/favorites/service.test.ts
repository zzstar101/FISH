import { describe, expect, test } from 'bun:test'
import { createFavoriteService, FavoriteServiceError } from './service'
import type { FavoriteRow, FavoriteStore } from './store'

const listingId = '01990000-0000-7000-8000-0000000000b1'
const viewer = '01990000-0000-7000-8000-0000000000a1'

const storage = { publicUrl: (key: string) => `https://cdn.example/${key}` }

function row(overrides: Partial<FavoriteRow> = {}): FavoriteRow {
  return {
    id: listingId,
    listingNo: 202609120001n,
    title: 'K380 键盘',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    createdAt: new Date('2026-09-12T01:00:00.000Z'),
    coverObjectKey: null,
    favoritedAt: '2026-09-12T03:00:00.123Z',
    favoritedAtCursor: '2026-09-12T03:00:00.123456Z',
    ...overrides,
  }
}

/** 只覆盖用到的行为，未用到的方法给能通过的最小实现。 */
function fakeStore(overrides: Partial<FavoriteStore> = {}): FavoriteStore {
  return {
    listingState: async () => ({ status: 'ACTIVE', governanceDelistedAt: null }),
    isFavorited: async () => false,
    listFavorites: async () => [],
    totalFavorites: async () => 0,
    addFavorite: async () => {},
    removeFavorite: async () => {},
    ...overrides,
  }
}

function serviceWith(overrides: Partial<FavoriteStore> = {}) {
  return createFavoriteService({ store: fakeStore(overrides), storage })
}

/** 断言「同码同文案的 404」：非法 / 不存在 / 不可见 / 不在售都必须落在这里。 */
async function expectListingNotFound(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(FavoriteServiceError)
    expect((error as FavoriteServiceError).status).toBe(404)
    expect((error as FavoriteServiceError).code).toBe('LISTING_NOT_FOUND')
    return
  }
  throw new Error('期望抛 LISTING_NOT_FOUND，但没有抛')
}

describe('favorite service — 可见性判据（三条路径共用）', () => {
  test('ACTIVE 且未被治理下架的商品可读可写', async () => {
    const service = serviceWith()
    expect(await service.getState(viewer, listingId)).toEqual({ favorited: false })
    expect(await service.favorite(viewer, listingId)).toEqual({ favorited: true })
    expect(await service.unfavorite(viewer, listingId)).toEqual({ favorited: false })
  })

  test('不存在、不在售、被平台下架一律 404 同码（不给 id / 治理状态留探针）', async () => {
    for (const state of [
      null,
      { status: 'OFFLINE' as const, governanceDelistedAt: null },
      { status: 'SOLD' as const, governanceDelistedAt: null },
      { status: 'RESERVED' as const, governanceDelistedAt: null },
      { status: 'ACTIVE' as const, governanceDelistedAt: new Date('2026-09-12T00:00:00.000Z') },
    ]) {
      const service = serviceWith({ listingState: async () => state })
      await expectListingNotFound(() => service.getState(viewer, listingId))
      await expectListingNotFound(() => service.favorite(viewer, listingId))
      await expectListingNotFound(() => service.unfavorite(viewer, listingId))
    }
  })

  test('判据不通过时一次都不写库', async () => {
    let writes = 0
    const service = serviceWith({
      listingState: async () => ({ status: 'SOLD', governanceDelistedAt: null }),
      addFavorite: async () => {
        writes += 1
      },
      removeFavorite: async () => {
        writes += 1
      },
    })
    await expectListingNotFound(() => service.favorite(viewer, listingId))
    await expectListingNotFound(() => service.unfavorite(viewer, listingId))
    expect(writes).toBe(0)
  })
})

describe('favorite service — 列表与分页', () => {
  test('回 items / total / nextCursor，卡片走公开投影', async () => {
    const service = serviceWith({
      listFavorites: async () => [row({ coverObjectKey: 'listings/u/1.png' })],
      totalFavorites: async () => 7,
    })
    const page = await service.listMyFavorites(viewer, { limit: 20 })

    expect(page.total).toBe(7)
    expect(page.nextCursor).toBeNull()
    expect(page.items[0]?.favoritedAt).toBe('2026-09-12T03:00:00.123Z')
    // 收藏者是买家视角：审核态三件套恒 null，即使数据行里有值也不透出去。
    expect(page.items[0]?.listing.moderationStatus).toBeNull()
    expect(page.items[0]?.listing.governanceDelisted).toBeNull()
    expect(page.items[0]?.listing.coverUrl).toBe('https://cdn.example/listings/u/1.png')
  })

  test('多取的那一行只用来判「还有下一页」，不进响应', async () => {
    const service = serviceWith({
      listFavorites: async (_u, limit) => Array.from({ length: limit + 1 }, () => row()),
      totalFavorites: async () => 2,
    })
    const page = await service.listMyFavorites(viewer, { limit: 1 })

    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    // 游标指回本页最后一行（微秒精度），下一页从这里继续。
    expect(page.total).toBe(2)
  })

  test('到底时 nextCursor 为 null', async () => {
    const service = serviceWith({
      listFavorites: async (_u, limit) => Array.from({ length: limit }, () => row()),
    })
    expect((await service.listMyFavorites(viewer, { limit: 2 })).nextCursor).toBeNull()
  })

  test('单行脏数据跳过而不是整页打不开，total 仍如实回报', async () => {
    const service = serviceWith({
      listFavorites: async () => [row({ category: 'NOT_A_CATEGORY' as FavoriteRow['category'] })],
      totalFavorites: async () => 1,
    })
    const page = await service.listMyFavorites(viewer, { limit: 20 })

    expect(page.items).toEqual([])
    expect(page.total).toBe(1)
  })

  test('非法游标 422，且不落到 store', async () => {
    let reads = 0
    const service = serviceWith({
      listFavorites: async () => {
        reads += 1
        return []
      },
    })
    try {
      await service.listMyFavorites(viewer, { limit: 20, cursor: 'garbage' })
      throw new Error('期望抛 422，但没有抛')
    } catch (error) {
      expect((error as FavoriteServiceError).status).toBe(422)
      expect((error as FavoriteServiceError).code).toBe('VALIDATION_FAILED')
    }
    expect(reads).toBe(0)
  })
})
