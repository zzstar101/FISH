import { describe, expect, test } from 'bun:test'
import type { ListingDetail } from '@fish/contracts/listings/schema'
import { errorBody } from '@fish/contracts/system/error'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { createListingsRouter } from './router'
import { type ListingService, ListingServiceError } from './service'

const LISTING_ID = '01930000-0000-7000-8000-000000000011'
const SELLER_ID = '01930000-0000-7000-8000-00000000000a'

const detail = {
  id: LISTING_ID,
  title: '罗技 K380 键盘',
  description: '宿舍用了一学期，功能正常。',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  status: 'ACTIVE',
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-12T03:40:10.000Z',
  updatedAt: '2026-09-12T03:40:10.000Z',
  images: [],
  seller: {
    id: SELLER_ID,
    nickname: '阿岚',
    avatarUrl: null,
    campus: '肇庆',
    authStatus: 'VERIFIED',
  },
  isOwner: false,
  moderationStatus: null,
} satisfies ListingDetail

function fakeService(overrides: Partial<ListingService> = {}): ListingService {
  return {
    listFeed: async () => ({ items: [], nextCursor: null }),
    getDetail: async () => detail,
    createListing: async () => ({ created: true, detail }),
    updateListing: async () => detail,
    transition: async () => detail,
    ...overrides,
  }
}

/**
 * 测试用的父 app 模拟 `app.ts` 的接线：只在写路由上挂登录守卫，读路由不挂。
 * 这正是契约 §0.2 的分界（读匿名可用、写必须登录），所以要在路由器层验证。
 */
function buildApp(options: {
  service: ListingService
  authed?: boolean
  viewerId?: string | null
}) {
  const authed = options.authed ?? true
  const root = new Hono()

  const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (!authed) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', SELLER_ID)
    await next()
  }

  root.route(
    '/listings',
    createListingsRouter({
      service: options.service,
      requireAuth,
      resolveViewerId: async () => options.viewerId ?? null,
    }),
  )

  return root
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

const validCreateBody = {
  title: '罗技 K380 键盘',
  description: '宿舍用了一学期，功能正常。',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  objectKeys: [`listings/${SELLER_ID}/a.jpg`],
}

describe('listings router — 读接口匿名可用', () => {
  test('GET /listings works without a session', async () => {
    const app = buildApp({ service: fakeService(), authed: false })
    const res = await app.request('/listings')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [], nextCursor: null })
  })

  test('GET /listings/:id works without a session and reports isOwner=false', async () => {
    const app = buildApp({ service: fakeService(), authed: false, viewerId: null })
    const res = await app.request(`/listings/${LISTING_ID}`)

    expect(res.status).toBe(200)
    expect((await res.json()) as ListingDetail).toMatchObject({ isOwner: false })
  })

  test('passes the resolved viewer id to the service', async () => {
    let viewer: string | null = 'unset'
    const app = buildApp({
      authed: true,
      viewerId: SELLER_ID,
      service: fakeService({
        getDetail: async (viewerId) => {
          viewer = viewerId
          return detail
        },
      }),
    })

    await app.request(`/listings/${LISTING_ID}`)
    expect(viewer).toBe(SELLER_ID)
  })

  // 非 UUID 的 :id 曾经直达 uuid 列 → PostgreSQL 类型错误 → 500；契约 §3 要求 404。
  // 这条路径任何匿名请求都能稳定触发，所以四个带 :id 的端点都要覆盖。
  test('returns 404 (not 500) for a non-UUID listing id', async () => {
    const app = buildApp({ service: fakeService(), authed: true })

    const responses = await Promise.all([
      app.request('/listings/not-a-uuid'),
      // body 必须是**合法**的，否则会先被请求体校验拦住（422），测不到 id 校验这条路径
      app.request('/listings/not-a-uuid', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceCents: 100 }),
      }),
      app.request('/listings/not-a-uuid/offline', { method: 'POST' }),
      app.request('/listings/not-a-uuid/online', { method: 'POST' }),
    ])

    for (const res of responses) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'LISTING_NOT_FOUND',
      )
    }
  })

  test('never reaches the service when the listing id is malformed', async () => {
    let calls = 0
    const app = buildApp({
      authed: true,
      service: fakeService({
        getDetail: async () => {
          calls += 1
          return detail
        },
      }),
    })

    await app.request('/listings/123')
    expect(calls).toBe(0)
  })

  test('rejects an invalid query with field-level details', async () => {
    const app = buildApp({ service: fakeService(), authed: false })
    const res = await app.request('/listings?status=SOLD')

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; details?: { field: string }[] } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.[0]?.field).toBe('status')
  })
})

describe('listings router — 写接口要求登录', () => {
  test('rejects anonymous writes with UNAUTHENTICATED', async () => {
    const app = buildApp({ service: fakeService(), authed: false })

    for (const [path, init] of [
      ['/listings', json(validCreateBody)],
      [
        `/listings/${LISTING_ID}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ],
      [`/listings/${LISTING_ID}/offline`, { method: 'POST' }],
      [`/listings/${LISTING_ID}/online`, { method: 'POST' }],
    ] as [string, RequestInit][]) {
      const res = await app.request(path, init)
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED')
    }
  })

  test('returns 201 on first create and 200 when the submit was deduplicated', async () => {
    const created = buildApp({ service: fakeService(), authed: true })
    expect((await created.request('/listings', json(validCreateBody))).status).toBe(201)

    const duplicate = buildApp({
      service: fakeService({ createListing: async () => ({ created: false, detail }) }),
      authed: true,
    })
    expect((await duplicate.request('/listings', json(validCreateBody))).status).toBe(200)
  })

  test('maps service errors onto the frozen error codes and statuses', async () => {
    const app = buildApp({
      service: fakeService({
        updateListing: async () => {
          throw new ListingServiceError(422, 'VALIDATION_FAILED', '0 元送时价格必须为 0', [
            { field: 'priceCents', message: '0 元送时价格必须为 0' },
          ])
        },
      }),
      authed: true,
    })

    const res = await app.request(`/listings/${LISTING_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ free: true, priceCents: 100 }),
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; details?: { field: string }[] } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.[0]?.field).toBe('priceCents')
  })

  test('rejects an empty PATCH body instead of silently succeeding', async () => {
    const app = buildApp({ service: fakeService(), authed: true })
    const res = await app.request(`/listings/${LISTING_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(422)
  })

  test('maps offline and online onto the transition targets', async () => {
    const targets: string[] = []
    const app = buildApp({
      service: fakeService({
        transition: async (_userId, _id, to) => {
          targets.push(to)
          return { ...detail, status: to }
        },
      }),
      authed: true,
    })

    await app.request(`/listings/${LISTING_ID}/offline`, { method: 'POST' })
    await app.request(`/listings/${LISTING_ID}/online`, { method: 'POST' })

    expect(targets).toEqual(['OFFLINE', 'ACTIVE'])
  })
})
