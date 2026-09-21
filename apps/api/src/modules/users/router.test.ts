import { describe, expect, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'
import type { PublicUserListingsQuery, PublicUserProfile } from '@fish/contracts/users/schema'
import { Hono } from 'hono'
import { createUsersRouter } from './router'
import { type PublicUserService, PublicUserServiceError } from './service'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const LISTING_ID = '01930000-0000-7000-8000-000000000011'

const profile: PublicUserProfile = {
  id: USER_ID,
  nickname: '林一',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  joinedDays: 19,
  activeCount: 3,
  soldCount: 1,
}

const card: ListingCard = {
  id: LISTING_ID,
  title: '二手台灯',
  priceCents: 3000,
  category: 'DAILY',
  condition: 'GOOD',
  status: 'ACTIVE',
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-10T02:00:00.000Z',
  moderationStatus: null,
}

function fakeService(overrides: Partial<PublicUserService> = {}): PublicUserService & {
  listCalls: { userId: string; query: PublicUserListingsQuery }[]
} {
  const listCalls: { userId: string; query: PublicUserListingsQuery }[] = []
  return {
    listCalls,
    async getPublicProfile() {
      return profile
    },
    async listActiveListings(userId, query) {
      listCalls.push({ userId, query })
      return { items: [card], nextCursor: null }
    },
    ...overrides,
  }
}

/** 模拟 `app.ts` 的接线：本域**整条匿名可读**，所以父 app 不挂任何守卫。 */
function buildApp(service: PublicUserService) {
  const root = new Hono()
  root.route('/', createUsersRouter({ service }))
  return root
}

describe('users router — 公开资料', () => {
  test('GET /users/:id/public 无需登录即可读', async () => {
    const res = await buildApp(fakeService()).request(`/users/${USER_ID}/public`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(profile)
  })

  test('非法 uuid 的路径参数 → 404 USER_NOT_FOUND，且不打到 service', async () => {
    let called = false
    const service = fakeService({
      async getPublicProfile() {
        called = true
        return profile
      },
    })

    const res = await buildApp(service).request('/users/not-a-uuid/public')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'USER_NOT_FOUND', message: '用户不存在或不可见' },
    })
    expect(called).toBe(false)
  })

  test('service 的不存在语义原样转成错误信封（404 同码）', async () => {
    const service = fakeService({
      async getPublicProfile() {
        throw new PublicUserServiceError(404, 'USER_NOT_FOUND', '用户不存在或不可见')
      },
    })

    const res = await buildApp(service).request(`/users/${USER_ID}/public`)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'USER_NOT_FOUND', message: '用户不存在或不可见' },
    })
  })
})

describe('users router — 在售列表', () => {
  test('GET /users/:id/listings 无需登录，limit 缺省为 20', async () => {
    const service = fakeService()
    const res = await buildApp(service).request(`/users/${USER_ID}/listings`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [card], nextCursor: null })
    expect(service.listCalls).toEqual([{ userId: USER_ID, query: { limit: 20 } }])
  })

  test('limit 与 cursor 透传给 service', async () => {
    const service = fakeService()
    const res = await buildApp(service).request(`/users/${USER_ID}/listings?limit=5&cursor=abc`)

    expect(res.status).toBe(200)
    expect(service.listCalls).toEqual([{ userId: USER_ID, query: { limit: 5, cursor: 'abc' } }])
  })

  test('非法查询参数 → 422 VALIDATION_FAILED 并带字段级 details', async () => {
    const service = fakeService()
    const res = await buildApp(service).request(`/users/${USER_ID}/listings?limit=999`)

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; details?: unknown[] } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details).toEqual([{ field: 'limit', message: expect.any(String) }])
    expect(service.listCalls).toEqual([])
  })

  test('非法 uuid 的路径参数 → 404，不查列表', async () => {
    const service = fakeService()
    const res = await buildApp(service).request('/users/xyz/listings')

    expect(res.status).toBe(404)
    expect(service.listCalls).toEqual([])
  })

  test('service 的 422（非法游标）原样透出 details', async () => {
    const service = fakeService({
      async listActiveListings() {
        throw new PublicUserServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
          { field: 'cursor', message: 'cursor 无效' },
        ])
      },
    })

    const res = await buildApp(service).request(`/users/${USER_ID}/listings?cursor=bad`)

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'cursor 无效',
        details: [{ field: 'cursor', message: 'cursor 无效' }],
      },
    })
  })
})
