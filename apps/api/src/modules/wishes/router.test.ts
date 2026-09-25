import { describe, expect, test } from 'bun:test'
import type { WishDto } from '@fish/contracts/wishes/schema'
import { Hono } from 'hono'
import { allowRestrictionGuard } from '../governance/testing'
import { createWishesRouter } from './router'
import type { WishService } from './service'
import type { WishRow, WishStore } from './store'

const dto: WishDto = {
  id: '00000000-0000-0000-0000-000000000001',
  userId: 'user-1',
  keyword: '机械键盘',
  category: 'DIGITAL',
  budgetMinCents: 10000,
  budgetMaxCents: 20000,
  description: null,
  acceptSimilar: true,
  status: 'ACTIVE',
  matchCount: 0,
  createdAt: '2026-09-12T06:00:00.000Z',
  updatedAt: '2026-09-12T06:00:00.000Z',
}

const service: WishService = {
  createWish: async () => dto,
  listWishes: async () => ({ items: [dto], total: 1 }),
  getWish: async () => dto,
  updateWish: async () => dto,
  closeWish: async () => ({ ...dto, status: 'CLOSED' }),
  fulfillWish: async () => ({ ...dto, status: 'FULFILLED' }),
  getPool: async () => ({ items: [] }),
}

const emptyStore = {} as WishStore
const creatingStore = Object.assign({} as WishStore, {
  createOrGetRecent: async (row: WishRow) => ({ kind: 'created' as const, row }),
})
const matchQueue = { enqueue: async () => undefined }
const root = new Hono<{ Variables: { userId: string } }>()
root.use('/wishes/*', async (c, next) => {
  c.set('userId', 'user-1')
  await next()
})
root.route(
  '/wishes',
  createWishesRouter({
    guard: allowRestrictionGuard,
    store: emptyStore,
    matchQueue,
    getUserId: (c) => c.get('userId'),
    service,
  }),
)

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  return root.request(path, { ...init, headers })
}

describe('wishes router', () => {
  test('requires a trusted identity context', async () => {
    const unauthedRoot = new Hono().route(
      '/wishes',
      createWishesRouter({
        guard: allowRestrictionGuard,
        store: emptyStore,
        matchQueue,
        getUserId: (c) => c.get('userId'),
        service,
      }),
    )
    expect((await unauthedRoot.request('/wishes')).status).toBe(401)
  })

  test('maps create, list, pool and transition routes', async () => {
    const createResponse = await request('/wishes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keyword: '机械键盘',
        category: 'DIGITAL',
        budgetMinCents: 10000,
        budgetMaxCents: 20000,
      }),
    })
    expect(createResponse.status).toBe(201)

    const listResponse = await request('/wishes?page=2&pageSize=5')
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toMatchObject({ page: 2, pageSize: 5, total: 1 })

    expect((await request('/wishes/pool')).status).toBe(200)
    expect(
      (await request('/wishes/00000000-0000-0000-0000-000000000001/close', { method: 'POST' }))
        .status,
    ).toBe(200)
    expect(
      (
        await request('/wishes/00000000-0000-0000-0000-000000000001/fulfill', {
          method: 'POST',
        })
      ).status,
    ).toBe(200)
  })

  test('returns 404 instead of 500 for a malformed wish id', async () => {
    const response = await request('/wishes/not-a-uuid')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  test('defaults to the no-op match queue when none is provided', async () => {
    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1')
      await next()
    })
    app.route(
      '/wishes',
      createWishesRouter({
        store: creatingStore,
        getUserId: (c) => c.get('userId'),
        guard: allowRestrictionGuard,
      }),
    )

    const response = await app.request('/wishes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keyword: '机械键盘',
        category: 'DIGITAL',
        budgetMinCents: 10000,
        budgetMaxCents: 20000,
      }),
    })

    expect(response.status).toBe(201)
  })

  test('returns 400 for invalid payloads', async () => {
    const response = await request('/wishes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyword: '!', category: 'unknown' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })

  test('maps a DB CHECK violation (23514) to 409 instead of 500', async () => {
    // 并发 PATCH 各改一端预算时，组合结果可能违反 wishes_budget_range_ordered；
    // 约束兜底保证数据正确，HTTP 语义应是 409 冲突而不是 500。
    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1')
      await next()
    })
    app.route(
      '/wishes',
      createWishesRouter({
        guard: allowRestrictionGuard,
        store: emptyStore,
        matchQueue,
        getUserId: (c) => c.get('userId'),
        service: {
          ...service,
          updateWish: async () => {
            throw Object.assign(new Error('violates check constraint'), { errno: '23514' })
          },
        },
      }),
    )

    const response = await app.request('/wishes/00000000-0000-0000-0000-000000000001', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetMaxCents: 20000 }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'CONFLICT' } })
  })
})
