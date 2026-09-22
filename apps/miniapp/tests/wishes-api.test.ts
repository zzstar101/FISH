import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ListingCard, ListingDetail } from '@fish/contracts/listings/schema'
import { MATCHING_ROUTES } from '@fish/contracts/matching/routes'
import type { WishMatchItem } from '@fish/contracts/matching/schema'
import { WISH_ROUTES } from '@fish/contracts/wishes/routes'
import type { WishCreateInput, WishDto, WishPoolItem } from '@fish/contracts/wishes/schema'

/**
 * 许愿 / 匹配接真接口的取数行为（#89 的接线）。
 *
 * 锁住三件在接接口时最容易做错、而且错了会被用户当成事实的事：
 * 1. **fail-closed**：愿望与愿望池任一取不到就是整页 `failed`，绝不回退 mock
 *    （mock 的 id 是 `w-001`，真实数据是 uuid，混在一起会造出「真愿望 + 演示命中」）；
 * 2. **命中的来源**：只对 `ACTIVE && matchCount > 0` 的愿望逐条拉
 *    `/matches?wishId=`，且单条失败不拖垮整页（卡片保留契约计数、不编排行）；
 * 3. **卖家**：`/matches` 不返回卖家，逐条拉详情补；补不到是 `null`，
 *    404 是「不存在」（notFound）、403 是「不是你的愿望」（forbidden），网络失败才是 failed。
 *
 * 替换的是 `@/lib/request` 的 `apiRequest`（只此一处），**不**替换 `features/wish/api`
 * 与 `features/match/api` —— 这样用例同时覆盖真实模块的**请求构造**
 * （路径、query、method、body）与契约解析，而不只是上层编排。被测入口是
 * `features/wish/load.ts`（不是 `features/fetchers.ts`）：那个模块不 import 会话域，
 * 测试因此不必跟着顶替 `chat/api`。
 * 手法与 `unread-hydrate.test.ts` 一致：`mock.module` 后再动态 import 被测模块。
 */

/** 契约错误信封在客户端侧的形状（`@/lib/request` 的 `isApiError` 按 name+code+status 认） */
class FakeApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type ApiCall = {
  path: string
  query?: Record<string, unknown>
  method?: string
  body?: unknown
}

/** 契约里几个必须合法的 id（`ListingIdSchema` 与 `MatchBaseSchema.id` 都是 `z.uuid()`） */
const WISH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LISTING_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LISTING_ID = '22222222-2222-4222-8222-222222222222'
const SELLER_ID = '33333333-3333-4333-8333-333333333333'
const MATCH_ID = '44444444-4444-4444-8444-444444444444'
const MATCH_ID_2 = '55555555-5555-4555-8555-555555555555'

const calls: ApiCall[] = []
let wishes: WishDto[] = []
let poolItems: WishPoolItem[] = []
let wishById: Map<string, WishDto> = new Map()
let matchLists: Map<string, { total: number; items: WishMatchItem[] }> = new Map()
let failWith: { when: (call: ApiCall) => boolean; error: unknown } | null = null
let detailImpl: (id: string) => Promise<ListingDetail | null> = () => Promise.resolve(null)
const detailCalls: string[] = []

/** 测试用的假后端：按 path + method 返回契约形状的响应 */
function respond(call: ApiCall): Promise<unknown> {
  if (failWith?.when(call)) return Promise.reject(failWith.error)

  if (call.path === WISH_ROUTES.base && call.method === 'POST') {
    return Promise.resolve(wishes[0] ?? wish({ id: 'w-created' }))
  }
  if (call.path === WISH_ROUTES.base) {
    const page = Number(call.query?.page ?? 1)
    const pageSize = Number(call.query?.pageSize ?? 50)
    const start = (page - 1) * pageSize
    return Promise.resolve({
      items: wishes.slice(start, start + pageSize),
      total: wishes.length,
      page,
      pageSize,
    })
  }
  if (call.path === WISH_ROUTES.pool) return Promise.resolve({ items: poolItems })
  if (call.path === MATCHING_ROUTES.base) {
    const wishId = String(call.query?.wishId)
    return Promise.resolve(matchLists.get(wishId) ?? { total: 0, items: [] })
  }
  if (call.path.endsWith('/close')) {
    const id = call.path.slice(WISH_ROUTES.base.length + 1, -'/close'.length)
    return Promise.resolve({ ...(wishById.get(id) ?? wish({ id })), status: 'CLOSED' })
  }
  if (call.path.startsWith(`${WISH_ROUTES.base}/`)) {
    const id = call.path.slice(WISH_ROUTES.base.length + 1)
    const found = wishById.get(id)
    return found
      ? Promise.resolve(found)
      : Promise.reject(new FakeApiError(404, 'NOT_FOUND', '愿望不存在'))
  }
  return Promise.reject(new Error(`测试未处理的请求：${call.path}`))
}

mock.module('@/lib/request', () => ({
  isApiError: (error: unknown) => error instanceof FakeApiError,
  isUnauthenticatedError: (error: unknown) =>
    error instanceof FakeApiError && error.status === 401 && error.code === 'UNAUTHENTICATED',
  ApiError: FakeApiError,
  apiRequest: (
    path: string,
    options: { query?: Record<string, unknown>; method?: string; body?: unknown } = {},
  ) => {
    const call: ApiCall = { path, query: options.query, method: options.method, body: options.body }
    calls.push(call)
    return respond(call)
  },
}))

// 构建期注入的开关（`config/index.ts` 的 defineConstants）。必须在动态 import 之前定义，
// 否则 `features/load-failure.ts` 在模块求值阶段就会 ReferenceError。
//
// `__ALLOW_MOCK_FALLBACK__` **故意置 true**（模拟开发 / 预览构建）：本文件的用例要证明
// 许愿系的 fail-closed 与这个开关**无关** —— 取数层根本没有 mock 回退分支，重新引入一条
// `MOCK_FALLBACK_ENABLED` 兜底就会让下面的 `failed` 断言失败。`__DEMO_AUTH__` 一并给出，
// 避免被间接引用时炸（本文件不触发演示登录）。
Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: true })

// 商品详情不在本文件覆盖范围（`loadWishMatches` 只用它补卖家），单独替换以便控制
// 「补不到」两种路径。`features/wish/load.ts` 刻意不静态 import 会话域（`chat/api`），
// 所以这里既不需要、也不应该 mock `chat/api` —— 那是 `unread-hydrate.test.ts` 的
// 部分 mock，跨文件顶替会让本文件在别的执行顺序下链接失败。
mock.module('@/features/listing/api', () => ({
  fetchCategoryListings: () => Promise.resolve([]),
  fetchHomeFeed: () => Promise.resolve([]),
  fetchListingDetail: (id: string) => {
    detailCalls.push(id)
    return detailImpl(id)
  },
  fetchSimilarListings: () => Promise.resolve([]),
  searchListings: () => Promise.resolve([]),
}))

const { loadWishes, loadWishMatches } = await import('../src/features/wish/load')
const { createWish, closeWish } = await import('../src/features/wish/api')
const { toMockWish, toMockWishPoolItem } = await import('../src/features/wish/adapt')

function wish(partial: Partial<WishDto> & { id: string }): WishDto {
  return {
    userId: '66666666-6666-4666-8666-666666666666',
    keyword: '显示器',
    category: 'DIGITAL',
    budgetMinCents: 20000,
    budgetMaxCents: 40000,
    description: null,
    acceptSimilar: true,
    status: 'ACTIVE',
    matchCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...partial,
  }
}

function card(id: string): ListingCard {
  return {
    id,
    title: `商品 ${id.slice(0, 4)}`,
    priceCents: 12345,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    // 卡片契约要求这个字段（`.nullable()`，不是 optional）：公开视角恒 null
    moderationStatus: null,
  }
}

function detail(id: string, nickname: string): ListingDetail {
  return {
    ...card(id),
    description: '描述',
    images: [],
    seller: {
      id: SELLER_ID,
      nickname,
      avatarUrl: null,
      authStatus: 'UNVERIFIED',
    },
    isOwner: false,
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function matched(id: string, listingId: string): WishMatchItem {
  return { id, score: 88, createdAt: '2026-09-01T00:00:00.000Z', listing: card(listingId) }
}

/** 找出发往某路径的调用（`method` 省略 = 只看路径） */
function callsTo(path: string, method?: string): ApiCall[] {
  return calls.filter(
    (call) => call.path === path && (method === undefined || call.method === method),
  )
}

beforeEach(() => {
  calls.length = 0
  detailCalls.length = 0
  wishes = []
  poolItems = []
  wishById = new Map()
  matchLists = new Map()
  failWith = null
  detailImpl = () => Promise.resolve(null)
})

describe('loadWishes —— 我的愿望 + 愿望池 + 命中', () => {
  test('成功：愿望按创建时间倒序，只对 ACTIVE 且有命中的愿望拉命中', async () => {
    wishes = [
      wish({ id: 'w-old', createdAt: '2026-09-01T00:00:00.000Z', matchCount: 2 }),
      wish({ id: 'w-new', createdAt: '2026-09-10T00:00:00.000Z', matchCount: 0 }),
      wish({
        id: 'w-closed',
        createdAt: '2026-09-05T00:00:00.000Z',
        status: 'CLOSED',
        matchCount: 3,
      }),
    ]
    poolItems = [{ keyword: '显示器', category: 'DIGITAL', wantCount: 4, medianBudgetCents: 30000 }]
    matchLists.set('w-old', { total: 2, items: [matched(MATCH_ID, LISTING_ID)] })

    const result = await loadWishes()
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.mine.map((item) => item.id)).toEqual(['w-new', 'w-closed', 'w-old'])
    expect(result.pool).toHaveLength(1)
    // 列表分页参数按契约（pageSize ≤ 50）
    expect(callsTo(WISH_ROUTES.base).at(0)?.query).toEqual({ page: 1, pageSize: 50 })
    expect(callsTo(WISH_ROUTES.pool)).toHaveLength(1)
    // 只有 ACTIVE 且 matchCount > 0 的愿望才发请求；limit 就是卡片展示行数（3）
    expect(callsTo(MATCHING_ROUTES.base)).toEqual([
      {
        path: MATCHING_ROUTES.base,
        query: { wishId: 'w-old', limit: 3 },
        method: undefined,
        body: undefined,
      },
    ])
    expect(result.hits['w-old']?.total).toBe(2)
    expect(result.hits['w-old']?.items[0]?.match).toEqual({
      id: MATCH_ID,
      wishId: 'w-old',
      listingId: LISTING_ID,
      score: 88,
    })
    // 终态愿望即使 matchCount > 0 也不拉（卡片不展示命中行）
    expect(result.hits['w-closed']).toBeUndefined()
  })

  test('单条命中失败不拖垮整页：该愿望没有命中条目，其余照常', async () => {
    wishes = [wish({ id: 'w-a', matchCount: 1 }), wish({ id: 'w-b', matchCount: 1 })]
    matchLists.set('w-b', { total: 1, items: [matched(MATCH_ID_2, LISTING_ID)] })
    failWith = {
      when: (call) => call.path === MATCHING_ROUTES.base && call.query?.wishId === 'w-a',
      error: new Error('boom'),
    }

    const result = await loadWishes()
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.hits['w-a']).toBeUndefined()
    expect(result.hits['w-b']?.total).toBe(1)
  })

  test('列表接口失败：整页 failed（fail-closed，mock 兜底开关打开也不回退）', async () => {
    failWith = {
      when: (call) => call.path === WISH_ROUTES.base && call.method !== 'POST',
      error: new Error('network down'),
    }

    expect(await loadWishes()).toEqual({ status: 'failed' })
  })

  test('愿望池失败：同样整页 failed，不拿半边数据凑合（mock 兜底开关打开也不回退）', async () => {
    wishes = [wish({ id: 'w-1' })]
    failWith = { when: (call) => call.path === WISH_ROUTES.pool, error: new Error('network down') }

    expect(await loadWishes()).toEqual({ status: 'failed' })
  })
})

describe('loadWishMatches —— 匹配结果 + 逐条补卖家', () => {
  test('成功：命中映射带上 wishId，卖家从商品详情补上，请求参数按契约', async () => {
    wishById.set(WISH_ID, wish({ id: WISH_ID, matchCount: 1 }))
    matchLists.set(WISH_ID, { total: 1, items: [matched(MATCH_ID, LISTING_ID)] })
    detailImpl = (id) => Promise.resolve(detail(id, '买家甲'))

    const result = await loadWishMatches(WISH_ID)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.wish.id).toBe(WISH_ID)
    expect(result.total).toBe(1)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.match.wishId).toBe(WISH_ID)
    expect(result.items[0]?.listing.id).toBe(LISTING_ID)
    expect(result.items[0]?.seller?.nickname).toBe('买家甲')
    expect(detailCalls).toEqual([LISTING_ID])
    // 目标走详情端点，匹配走 /matches?wishId=&limit=
    expect(callsTo(WISH_ROUTES.detail(WISH_ID))).toHaveLength(1)
    expect(callsTo(MATCHING_ROUTES.base).at(0)?.query).toEqual({ wishId: WISH_ID, limit: 50 })
  })

  test('total 原样回传，不拿 items.length 顶替（服务端可能跳过无法映射的卡片）', async () => {
    wishById.set(WISH_ID, wish({ id: WISH_ID }))
    matchLists.set(WISH_ID, { total: 7, items: [matched(MATCH_ID, LISTING_ID)] })
    detailImpl = (id) => Promise.resolve(detail(id, '买家甲'))

    const result = await loadWishMatches(WISH_ID)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.total).toBe(7)
    expect(result.items).toHaveLength(1)
  })

  test('补卖家失败：该行 seller 为 null（不编造），其余照常补上', async () => {
    wishById.set(WISH_ID, wish({ id: WISH_ID }))
    matchLists.set(WISH_ID, {
      total: 2,
      items: [matched(MATCH_ID, LISTING_ID), matched(MATCH_ID_2, OTHER_LISTING_ID)],
    })
    detailImpl = (id) =>
      id === LISTING_ID ? Promise.reject(new Error('boom')) : Promise.resolve(detail(id, '买家乙'))

    const result = await loadWishMatches(WISH_ID)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.items[0]?.seller).toBeNull()
    expect(result.items[1]?.seller?.nickname).toBe('买家乙')
  })

  test('404 = 愿望不存在：notFound', async () => {
    failWith = {
      when: (call) => call.path === WISH_ROUTES.detail(WISH_ID),
      error: new FakeApiError(404, 'NOT_FOUND', '愿望不存在'),
    }
    expect((await loadWishMatches(WISH_ID)).status).toBe('notFound')
  })

  test('403 = 不是当前账号的愿望：forbidden，不能说成「已结束」', async () => {
    failWith = {
      when: (call) => call.path === WISH_ROUTES.detail(WISH_ID),
      error: new FakeApiError(403, 'FORBIDDEN', '无权查看该愿望'),
    }
    expect((await loadWishMatches(WISH_ID)).status).toBe('forbidden')
  })

  test('网络 / 契约失败：failed（页面给重试），不冒充「已结束」', async () => {
    wishById.set(WISH_ID, wish({ id: WISH_ID }))
    failWith = { when: (call) => call.path === MATCHING_ROUTES.base, error: new Error('down') }

    expect((await loadWishMatches(WISH_ID)).status).toBe('failed')
  })

  test('非法 wishId（旧 mock 链接）：直接 notFound，且一个请求都不发', async () => {
    // 两个端点对非法 id 给 404 / 422 两种拒绝，谁先 settle 谁决定页面状态 —— 客户端先挡住
    expect((await loadWishMatches('w-011')).status).toBe('notFound')
    expect(calls).toHaveLength(0)
  })
})

describe('写操作请求构造', () => {
  test('createWish：POST /wishes，body 原样透传，响应按契约解析', async () => {
    const input: WishCreateInput = {
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMinCents: 10000,
      budgetMaxCents: 25000,
      acceptSimilar: true,
    }
    wishes = [wish({ id: 'w-created', keyword: input.keyword })]

    const created = await createWish(input)
    expect(created.id).toBe('w-created')
    expect(callsTo(WISH_ROUTES.base, 'POST')).toEqual([
      { path: WISH_ROUTES.base, query: undefined, method: 'POST', body: input },
    ])
  })

  test('closeWish：POST /wishes/:id/close', async () => {
    wishById.set(WISH_ID, wish({ id: WISH_ID, status: 'ACTIVE' }))

    const closed = await closeWish(WISH_ID)
    expect(closed.status).toBe('CLOSED')
    expect(callsTo(WISH_ROUTES.close(WISH_ID), 'POST')).toHaveLength(1)
  })
})

describe('契约 → 页面视图的投影', () => {
  test('toMockWish：契约字段透传；timeLabel 由 createdAt 现算', () => {
    const createdAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const view = toMockWish(wish({ id: 'w-1', createdAt, matchCount: 5 }))

    expect(view.id).toBe('w-1')
    expect(view.timeLabel).toBe('2 小时前')
    expect(view.matchCount).toBe(5)
    // 契约没有所有者 id 的用途：不编一个
    expect(view.userId).toBe('')
  })

  test('toMockWishPoolItem：聚合字段原样透传', () => {
    expect(
      toMockWishPoolItem({
        keyword: 'ipad',
        category: 'DIGITAL',
        wantCount: 6,
        medianBudgetCents: 150000,
      }),
    ).toEqual({
      keyword: 'ipad',
      category: 'DIGITAL',
      wantCount: 6,
      medianBudgetCents: 150000,
    })
  })
})
