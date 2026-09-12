import { describe, expect, test } from 'bun:test'
import type { WishDto } from '@fish/contracts/wishes/schema'
import { Hono } from 'hono'
import { createWishesRouter } from './router'
import type { WishService } from './service'
import type { WishRow, WishStore } from './store'

const dto: WishDto = {
  id: 'wish-1',
  userId: 'user-1',
  keyword: '机械键盘',
  category: 'electronics',
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
root.use('/api/wishes/*', async (c, next) => {
  c.set('userId', 'user-1')
  await next()
})
root.route(
  '/api/wishes',
  createWishesRouter({
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
      '/api/wishes',
      createWishesRouter({
        store: emptyStore,
        matchQueue,
        getUserId: (c) => c.get('userId'),
        service,
      }),
    )
    expect((await unauthedRoot.request('/api/wishes')).status).toBe(401)
  })

  test('maps create, list, pool and transition routes', async () => {
    const createResponse = await request('/api/wishes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keyword: '机械键盘',
        category: 'electronics',
        budgetMinCents: 10000,
        budgetMaxCents: 20000,
      }),
    })
    expect(createResponse.status).toBe(201)

    const listResponse = await request('/api/wishes?page=2&pageSize=5')
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toMatchObject({ page: 2, pageSize: 5, total: 1 })

    expect((await request('/api/wishes/pool')).status).toBe(200)
    expect((await request('/api/wishes/wish-1/close', { method: 'POST' })).status).toBe(200)
    expect((await request('/api/wishes/wish-1/fulfill', { method: 'POST' })).status).toBe(200)
  })

  test('defaults to the no-op match queue when none is provided', async () => {
    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1')
      await next()
    })
    app.route(
      '/api/wishes',
      createWishesRouter({ store: creatingStore, getUserId: (c) => c.get('userId') }),
    )

    const response = await app.request('/api/wishes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keyword: '机械键盘',
        category: 'electronics',
        budgetMinCents: 10000,
        budgetMaxCents: 20000,
      }),
    })

    expect(response.status).toBe(201)
  })

  test('returns 400 for invalid payloads', async () => {
    const response = await request('/api/wishes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyword: '!', category: 'unknown' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })
})
