import { describe, expect, test } from 'bun:test'
import type {
  ListingMatchListResponse,
  WishMatchListResponse,
} from '@fish/contracts/matching/schema'
import { errorBody } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { createMatchingRouter } from './router'
import { type MatchingService, MatchingServiceError } from './service'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const RAW_WISH_ID = '01930000-0000-7000-8000-000000000021'
const WISH_ID = encodePublicId(PUBLIC_ID_PREFIX.wish, RAW_WISH_ID)
const RAW_LISTING_ID = '01930000-0000-7000-8000-000000000011'
const LISTING_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, RAW_LISTING_ID)

const wishResponse: WishMatchListResponse = {
  total: 1,
  items: [
    {
      id: encodePublicId(PUBLIC_ID_PREFIX.match, '01930000-0000-7000-8000-000000000031'),
      score: 92,
      createdAt: '2026-09-12T03:40:10.000Z',
      listing: {
        id: LISTING_ID,
        title: '罗技 K380 键盘',
        priceCents: 16000,
        category: 'DIGITAL',
        condition: 'GOOD',
        status: 'ACTIVE',
        urgent: false,
        negotiable: true,
        free: false,
        coverUrl: null,
        createdAt: '2026-09-12T03:40:10.000Z',
        moderationStatus: null,
      },
    },
  ],
}

const listingResponse: ListingMatchListResponse = {
  total: 1,
  items: [
    {
      id: encodePublicId(PUBLIC_ID_PREFIX.match, '01930000-0000-7000-8000-000000000031'),
      score: 92,
      createdAt: '2026-09-12T03:40:10.000Z',
      wish: {
        id: WISH_ID,
        keyword: '机械键盘',
        category: 'DIGITAL',
        budgetMinCents: null,
        budgetMaxCents: 20000,
      },
    },
  ],
}

function fakeService(overrides: Partial<MatchingService> = {}): MatchingService {
  return {
    listByWish: async () => wishResponse,
    listByListing: async () => listingResponse,
    ...overrides,
  }
}

/**
 * 测试用的父 app 模拟 `app.ts` 的接线：`/matches` 整条路由都要求登录（契约 §0.2）。
 * 这里用一个可控的 requireAuth 替代真实 auth 中间件。
 */
function buildApp(options: { service: MatchingService; authed?: boolean }) {
  const authed = options.authed ?? true
  const root = new Hono()

  const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (!authed) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', USER_ID)
    c.set('me', { id: USER_ID } as never)
    await next()
  }

  root.route('/matches', createMatchingRouter({ service: options.service, requireAuth }))
  return root
}

const get = (app: Hono, path: string) => app.request(path)

describe('GET /matches', () => {
  test('未登录返回 401 UNAUTHENTICATED', async () => {
    const res = await get(
      buildApp({ service: fakeService(), authed: false }),
      `/matches?wishId=${WISH_ID}`,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual(errorBody('UNAUTHENTICATED', '请先登录'))
  })

  test('按 wishId 返回愿望侧的匹配，limit 默认 10', async () => {
    const calls: unknown[] = []
    const service = fakeService({
      listByWish: async (userId, wishId, limit) => {
        calls.push({ userId, wishId, limit })
        return wishResponse
      },
    })

    const res = await get(buildApp({ service }), `/matches?wishId=${WISH_ID}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(wishResponse)
    expect(calls).toEqual([{ userId: USER_ID, wishId: RAW_WISH_ID, limit: 10 }])
  })

  test('按 listingId 返回商品侧的匹配，并透传 limit', async () => {
    const calls: unknown[] = []
    const service = fakeService({
      listByListing: async (userId, listingId, limit) => {
        calls.push({ userId, listingId, limit })
        return listingResponse
      },
    })

    const res = await get(buildApp({ service }), `/matches?listingId=${LISTING_ID}&limit=3`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(listingResponse)
    expect(calls).toEqual([{ userId: USER_ID, listingId: RAW_LISTING_ID, limit: 3 }])
  })

  // 两个过滤参数恰好一个（契约 §2）：两个都给、都不给、以及越界的 limit 都是参数错误。
  test('参数不合法返回 422 VALIDATION_FAILED 且带 details', async () => {
    const app = buildApp({ service: fakeService() })

    for (const query of [
      `wishId=${WISH_ID}&listingId=${LISTING_ID}`,
      '',
      `wishId=${WISH_ID}&limit=51`,
      `wishId=${WISH_ID}&cursor=abc`,
      'wishId=not-a-uuid',
    ]) {
      const res = await get(app, `/matches?${query}`)
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string; details?: unknown[] } }
      expect(body.error.code).toBe('VALIDATION_FAILED')
      expect(Array.isArray(body.error.details)).toBe(true)
      expect((body.error.details ?? []).length).toBeGreaterThan(0)
    }
  })

  test('目标不存在返回 404 MATCH_TARGET_NOT_FOUND，非本人返回 403 NOT_TARGET_OWNER', async () => {
    const notFound = buildApp({
      service: fakeService({
        listByWish: async () => {
          throw new MatchingServiceError(404, 'MATCH_TARGET_NOT_FOUND', '目标不存在')
        },
      }),
    })
    const res404 = await get(notFound, `/matches?wishId=${WISH_ID}`)
    expect(res404.status).toBe(404)
    expect(await res404.json()).toEqual(errorBody('MATCH_TARGET_NOT_FOUND', '目标不存在'))

    const notOwner = buildApp({
      service: fakeService({
        listByListing: async () => {
          throw new MatchingServiceError(403, 'NOT_TARGET_OWNER', '无权查看该目标的匹配')
        },
      }),
    })
    const res403 = await get(notOwner, `/matches?listingId=${LISTING_ID}`)
    expect(res403.status).toBe(403)
    expect(await res403.json()).toEqual(errorBody('NOT_TARGET_OWNER', '无权查看该目标的匹配'))
  })
})
