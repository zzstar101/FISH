import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { FAVORITE_ROUTES } from '@fish/contracts/favorites/routes'
import type { ProfileResponse } from '@fish/contracts/profile/schema'

/**
 * 个人中心收藏计数与「我的收藏」列表**同源**（#190 验收：「个人中心计数同源，
 * 读不到显示未知而非 0」）。
 *
 * 锁住两件接计数时最容易做错、错了会被用户当成事实的事：
 * 1. **同源**：计数取 `GET /me/favorites` 回包的全量 `total`（只读 1 行，limit=1），
 *    不是 `profileStats` 里编一个字段（`favoriteCount` 被 #190 冻结不加），也不是
 *    本地数出来的行数 —— 两个数字各算各的就会出现「数字栏 8、点进去 6 件」。
 * 2. **读不到是 `null` 不是 0**：计数请求失败只让数字栏显示 `—`，
 *    **不连累整页 profile**（profile 成功照样返回）。
 *
 * 替换的是 `@/lib/request` 的 `apiRequest`（只此一处）与 `@/features/profile/api` 的
 * `fetchProfile`（profile 本体的形状与解析不在本文件覆盖范围）。收藏 API
 * （`features/favorites/api`）**不**顶替 —— 这样用例同时覆盖真实模块的请求构造
 * （limit=1）与契约解析。手法与 `wishes-api.test.ts` 一致：`mock.module` 后再动态
 * import 被测模块。
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

const calls: ApiCall[] = []

/** 收藏列表端点当前的行为：`total` 可调，`favoritesFails` 时按 500 拒绝 */
let favoritesTotal = 7
let favoritesFails = false

function respond(call: ApiCall): Promise<unknown> {
  if (call.path === FAVORITE_ROUTES.myFavorites) {
    if (favoritesFails) return Promise.reject(new FakeApiError(500, 'INTERNAL', 'db down'))
    return Promise.resolve({ items: [], nextCursor: null, total: favoritesTotal })
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

/** `@tarojs/taro` 一并顶掉：Bun 下加载真 Taro 会在求值阶段抛（手法同 `favorites-list.test.ts`） */
mock.module('@tarojs/taro', () => ({ default: {} }))

// profile 本体不在本文件覆盖范围（user/stats/listings/wishes/transactions 的解析是
// `profile/api` + 契约的事），整模块替换以控制返回；loadProfile 只消费这几个字段。
let profileFails = false
mock.module('@/features/profile/api', () => ({
  fetchProfile: () => {
    if (profileFails) return Promise.reject(new FakeApiError(500, 'INTERNAL', 'db down'))
    const profile = {
      user: { id: '01930000-0000-7000-8000-000000000001' },
      stats: {
        activeListings: 2,
        activeWishes: 1,
        completedTransactions: 3,
        followingCount: 5,
      },
      listings: [],
      wishes: [],
      transactions: [],
    } as unknown as ProfileResponse
    return Promise.resolve(profile)
  },
  updateProfile: () => Promise.reject(new Error('测试不覆盖 profile 写路径')),
}))

// 构建期注入的开关（`config/index.ts` 的 defineConstants）。必须在动态 import 之前定义，
// 否则 `features/load-failure.ts` 在模块求值阶段就会 ReferenceError。两开关**都置 false**
//（模拟生产构建）：本文件要锁的是真实路径的计数接线，任何 mock 回退分支被重新引入
// 时，这里的断言都会如实变红。
Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: false })

const { loadProfile } = await import('../src/features/fetchers')

beforeEach(() => {
  calls.length = 0
  favoritesTotal = 7
  favoritesFails = false
  profileFails = false
})

describe('个人中心收藏计数 —— 与「我的收藏」列表同源（#190）', () => {
  test('favoritesCount = GET /me/favorites 的全量 total，且只读 1 行（limit=1）', async () => {
    const profile = await loadProfile()
    expect(profile?.favoritesCount).toBe(7)
    const favCall = calls.filter((call) => call.path === FAVORITE_ROUTES.myFavorites)
    expect(favCall.length).toBe(1)
    expect(favCall[0]?.query?.limit).toBe(1)
    expect(favCall[0]?.query?.cursor).toBeUndefined()
  })

  test('计数读不到 → favoritesCount 为 null，profile 本体照常返回（不把未知画成 0）', async () => {
    favoritesFails = true
    const profile = await loadProfile()
    expect(profile?.favoritesCount).toBeNull()
    expect(profile?.user).toEqual({ id: '01930000-0000-7000-8000-000000000001' })
    expect(profile?.followCount).toBe(5)
  })

  test('计数不是本地数出来的行数：total 与返回行数无关（本用例 items 为空）', async () => {
    favoritesTotal = 42
    const profile = await loadProfile()
    expect(profile?.favoritesCount).toBe(42)
  })

  test('profile 本体失败 → 整体 fail-closed 返回 null（计数分支不掩盖主请求）', async () => {
    profileFails = true
    const profile = await loadProfile()
    expect(profile).toBeNull()
  })
})
