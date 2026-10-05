import { describe, expect, test } from 'bun:test'
import { createFavoriteService, FavoriteServiceError } from './service'
import type { FavoriteListingState, FavoriteRow, FavoriteStore } from './store'

const listingId = '01990000-0000-7000-8000-0000000000b1'
const viewer = '01990000-0000-7000-8000-0000000000a1'
const seller = '01990000-0000-7000-8000-0000000000a3'

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
    // 卖家公开子集（#191）：卡片源自 #344 起 `seller` 必填，fake 行也必须给。
    seller: { id: seller, nickname: '卖家', avatarUrl: null, authStatus: 'VERIFIED' },
    // 想要数（已建会话的买家数）：卡片契约的必填字段，fake 行给 0（本用例不关心它）。
    wants: 0,
    coverObjectKey: null,
    favoritedAt: '2026-09-12T03:00:00.123Z',
    favoritedAtCursor: '2026-09-12T03:00:00.123456Z',
    ...overrides,
  }
}

function listingState(overrides: Partial<FavoriteListingState> = {}): FavoriteListingState {
  return {
    status: 'ACTIVE',
    moderationStatus: 'APPROVED',
    governanceDelistedAt: null,
    sellerId: seller,
    ...overrides,
  }
}

/** 只覆盖用到的行为，未用到的方法给能通过的最小实现。 */
function fakeStore(overrides: Partial<FavoriteStore> = {}): FavoriteStore {
  return {
    listingState: async () => listingState(),
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

/** 断言「同码同文案的 404」：不存在 / 不可见 / 不在售都必须落在这里。 */
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

describe('favorite service — 收藏（POST）只允许在售商品', () => {
  test('ACTIVE 且未被治理下架时可以收藏', async () => {
    const service = serviceWith()
    expect(await service.favorite(viewer, listingId)).toEqual({ favorited: true })
  })

  test('不存在、不在售、被平台下架一律 404，且一次都不写库', async () => {
    for (const state of [
      null,
      listingState({ status: 'OFFLINE' }),
      listingState({ status: 'SOLD' }),
      listingState({ status: 'RESERVED' }),
      listingState({ governanceDelistedAt: new Date('2026-09-12T00:00:00.000Z') }),
    ]) {
      let writes = 0
      const service = serviceWith({
        listingState: async () => state,
        addFavorite: async () => {
          writes += 1
        },
      })
      await expectListingNotFound(() => service.favorite(viewer, listingId))
      expect(writes).toBe(0)
    }
  })

  test('审核中 / 未过审（REVIEW / BLOCKED）一律 404，且一次都不写库', async () => {
    // `ACTIVE` 只说明没被下架：`REVIEW` / `BLOCKED` 的条目对非卖家**不可见**（详情页 404）。
    // 放行这条登录可达的写路径，等于给出「某个 id 是否存在且正在审核」的探针。
    for (const state of [
      listingState({ moderationStatus: 'REVIEW' }),
      listingState({ moderationStatus: 'BLOCKED' }),
    ]) {
      let writes = 0
      const service = serviceWith({
        listingState: async () => state,
        addFavorite: async () => {
          writes += 1
        },
      })
      await expectListingNotFound(() => service.favorite(viewer, listingId))
      expect(writes).toBe(0)
    }
  })
})

describe('favorite service — 读状态（GET）镜像详情页可见性', () => {
  test('在售、已售、已预定都能读到真实状态（这些商品的详情页是公开可读的）', async () => {
    for (const status of ['ACTIVE', 'SOLD', 'RESERVED'] as const) {
      const service = serviceWith({
        listingState: async () => listingState({ status }),
        isFavorited: async () => true,
      })
      expect(await service.getState(viewer, listingId)).toEqual({ favorited: true })
    }
  })

  test('下架或未过审：非卖家 404，卖家本人仍可读', async () => {
    for (const state of [
      listingState({ status: 'OFFLINE' }),
      listingState({ moderationStatus: 'BLOCKED' }),
      listingState({ moderationStatus: 'REVIEW' }),
      listingState({ moderationStatus: null }),
    ]) {
      const service = serviceWith({ listingState: async () => state })
      await expectListingNotFound(() => service.getState(viewer, listingId))
      // 卖家本人能打开自己的商品详情页，收藏态也就不该对他 404。
      expect(await service.getState(seller, listingId)).toEqual({ favorited: false })
    }
  })

  test('商品不存在 404', async () => {
    await expectListingNotFound(() =>
      serviceWith({ listingState: async () => null }).getState(viewer, listingId),
    )
  })
})

describe('favorite service — 取消收藏（DELETE）无条件幂等', () => {
  test('失效条目（已售 / 已下架 / 被平台下架）必须能取消掉', async () => {
    // 这是列表里最常见的一类：收藏之后商品卖掉了或下架了。取消不掉等于收藏夹只能进不能出。
    for (const state of [
      listingState({ status: 'SOLD' }),
      listingState({ status: 'OFFLINE' }),
      listingState({ status: 'RESERVED' }),
      listingState({ governanceDelistedAt: new Date('2026-09-12T00:00:00.000Z') }),
      null, // 商品已不存在
    ]) {
      let removed = 0
      const service = serviceWith({
        listingState: async () => state,
        removeFavorite: async () => {
          removed += 1
        },
      })
      expect(await service.unfavorite(viewer, listingId)).toEqual({ favorited: false })
      expect(removed).toBe(1)
    }
  })

  test('不查商品状态：连 listingState 都不读（不给 id 存在性留探针）', async () => {
    let reads = 0
    const service = serviceWith({
      listingState: async () => {
        reads += 1
        return listingState()
      },
    })
    expect(await service.unfavorite(viewer, listingId)).toEqual({ favorited: false })
    expect(reads).toBe(0)
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
    // 卖家公开子集（#191）：收藏列表的卡片与 feed / 详情同一形状，必须带出卖家；
    // 公开 id 是 TypeID 编码（`usr_` 前缀 + Crockford base32，不是裸 uuid），
    // 且只有四个公开字段 —— 教育邮箱 / 学号 / 手机号 / role 一律不进列表投影。
    const cardSeller = page.items[0]?.listing.seller
    expect(cardSeller?.id.startsWith('usr_')).toBe(true)
    expect(cardSeller?.id).not.toContain('01990000-0000-7000-8000-0000000000a3')
    expect(cardSeller?.nickname).toBe('卖家')
    expect(cardSeller?.avatarUrl).toBeNull()
    expect(cardSeller?.authStatus).toBe('VERIFIED')
    expect(Object.keys(cardSeller ?? {}).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'id',
      'nickname',
    ])
  })

  test('多取的那一行只用来判「还有下一页」，不进响应', async () => {
    const service = serviceWith({
      listFavorites: async (_u, limit) => Array.from({ length: limit + 1 }, () => row()),
      totalFavorites: async () => 2,
    })
    const page = await service.listMyFavorites(viewer, { limit: 1 })

    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
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
