import { describe, expect, test } from 'bun:test'
import { FAVORITE_ROUTES } from '@fish/contracts/favorites/routes'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { Hono } from 'hono'
import { createFavoritesRouter } from './router'
import type { FavoriteService } from './service'

const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, '01990000-0000-7000-8000-0000000000b1')
const relationPath = FAVORITE_ROUTES.favoriteRelation(listingId)

function fakeService(overrides: Partial<FavoriteService> = {}): FavoriteService {
  return {
    listMyFavorites: async () => ({ items: [], nextCursor: null, total: 0 }),
    getState: async () => ({ favorited: false }),
    favorite: async () => ({ favorited: true }),
    unfavorite: async () => ({ favorited: false }),
    ...overrides,
  }
}

type TestRoot = Hono<{ Variables: { userId: string } }>

/**
 * 真 app 里 `requireAuth` 由 `app.ts` 挂在两条路径上（见那里的注释）；这里用外层中间件
 * 模拟「已登录」，`signedIn: false` 时模拟匿名 —— router 自己的兜底必须失败关闭。
 */
function buildRoot(service: FavoriteService, signedIn = true): TestRoot {
  const root = new Hono<{ Variables: { userId: string } }>()
  root.use('*', async (c, next) => {
    if (signedIn) c.set('userId', 'user-1')
    await next()
  })
  root.route('/', createFavoritesRouter({ service, getUserId: (c) => c.get('userId') }))
  return root
}

/** service 被调用的次数：用来证明「被挡下的请求一次都没进业务层」。 */
function countingService(overrides: Partial<FavoriteService> = {}) {
  let calls = 0
  const base = fakeService(overrides)
  const wrapped = Object.fromEntries(
    Object.entries(base).map(([key, fn]) => [
      key,
      (...args: unknown[]) => {
        calls += 1
        return (fn as (...a: unknown[]) => unknown)(...args)
      },
    ]),
  ) as unknown as FavoriteService
  return { service: wrapped, calls: () => calls }
}

describe('favorites router', () => {
  test('两条路径都要求登录，匿名一律 401 UNAUTHENTICATED', async () => {
    const { service, calls } = countingService()
    const root = buildRoot(service, false)

    for (const init of [
      { path: FAVORITE_ROUTES.myFavorites },
      { path: relationPath },
      { path: relationPath, method: 'POST' },
      { path: relationPath, method: 'DELETE' },
    ]) {
      const response = await root.request(init.path, { method: init.method ?? 'GET' })
      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHENTICATED',
      )
    }
    // 兜底在业务层之前：一个假 service 调用都不该发生。
    expect(calls()).toBe(0)
  })

  test('非法商品 id 与不存在同码 404，且不进业务层', async () => {
    const { service, calls } = countingService()
    const root = buildRoot(service)

    for (const path of [
      FAVORITE_ROUTES.favoriteRelation('not-a-listing-id'),
      FAVORITE_ROUTES.favoriteRelation('01990000-0000-7000-8000-0000000000b1'), // 裸 uuid 也不行
    ]) {
      const response = await root.request(path)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'LISTING_NOT_FOUND',
      )
    }
    expect(calls()).toBe(0)
  })

  test('列表回 200 与契约形状', async () => {
    const root = buildRoot(
      fakeService({
        listMyFavorites: async (_userId, query) => {
          expect(query.limit).toBe(20)
          return { items: [], nextCursor: null, total: 0 }
        },
      }),
    )
    const response = await root.request(FAVORITE_ROUTES.myFavorites)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [], nextCursor: null, total: 0 })
  })

  test('列表参数不合法回 422（含越权的 userId 参数）', async () => {
    const { service, calls } = countingService()
    const root = buildRoot(service)

    for (const query of ['limit=0', 'limit=51', `userId=${listingId}`]) {
      const response = await root.request(`${FAVORITE_ROUTES.myFavorites}?${query}`)
      expect(response.status).toBe(422)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
    }
    expect(calls()).toBe(0)
  })

  test('状态读与两个写接口都回服务端结论，写接口不是 204', async () => {
    const root = buildRoot(fakeService())

    const state = await root.request(relationPath)
    expect(state.status).toBe(200)
    expect(await state.json()).toEqual({ favorited: false })

    const added = await root.request(relationPath, { method: 'POST' })
    expect(added.status).toBe(200)
    expect(await added.json()).toEqual({ favorited: true })

    const removed = await root.request(relationPath, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ favorited: false })
  })

  test('业务层抛出的错误按状态码与错误码透出', async () => {
    const root = buildRoot(
      fakeService({
        favorite: async () => {
          const { FavoriteServiceError } = await import('./service')
          throw new FavoriteServiceError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')
        },
      }),
    )
    const response = await root.request(relationPath, { method: 'POST' })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      '商品不存在或不可见',
    )
  })
})
