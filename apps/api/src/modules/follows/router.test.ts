import { describe, expect, test } from 'bun:test'
import type {
  FollowState,
  MyFollowingQuery,
  MyFollowingResponse,
} from '@fish/contracts/follows/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { Hono } from 'hono'
import { createFollowsRouter } from './router'
import { type FollowService, FollowServiceError } from './service'

const VIEWER = '01930000-0000-7000-8000-00000000000a'
const TARGET = '01930000-0000-7000-8000-00000000000b'
const TARGET_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, TARGET)

const state: FollowState = { following: true, mutual: false }
const page: MyFollowingResponse = {
  items: [
    {
      id: TARGET_PUBLIC,
      nickname: '林一',
      avatarUrl: null,
      authStatus: 'VERIFIED',
      mutual: false,
    },
  ],
  nextCursor: null,
  total: 1,
  mutualTotal: 0,
}

function fakeService(overrides: Partial<FollowService> = {}): FollowService & {
  listCalls: { userId: string; query: MyFollowingQuery }[]
  stateCalls: { viewerId: string; targetId: string }[]
} {
  const listCalls: { userId: string; query: MyFollowingQuery }[] = []
  const stateCalls: { viewerId: string; targetId: string }[] = []
  return {
    listCalls,
    stateCalls,
    async listMyFollowing(userId, query) {
      listCalls.push({ userId, query })
      return page
    },
    async getState(viewerId, targetId) {
      stateCalls.push({ viewerId, targetId })
      return state
    },
    async follow(viewerId, targetId) {
      stateCalls.push({ viewerId, targetId })
      return { following: true, mutual: false }
    },
    async unfollow(viewerId, targetId) {
      stateCalls.push({ viewerId, targetId })
      return { following: false, mutual: false }
    },
    ...overrides,
  }
}

/**
 * 模拟 `app.ts` 的接线：`getUserId` 读的是 requireAuth 写入的可信 context。测试里用一个
 * 请求头冒充它（真实接线的头部信任问题由 auth middleware 负责，不在本 router 的测试范围）。
 */
function buildApp(service: FollowService, viewerId: string | null = VIEWER) {
  const root = new Hono()
  root.route('/', createFollowsRouter({ service, getUserId: () => viewerId ?? undefined }))
  return root
}

describe('follows router — 认证兜底', () => {
  test('拿不到可信 userId → 401 UNAUTHENTICATED，且不打 service', async () => {
    const service = fakeService()
    const res = await buildApp(service, null).request('/me/following')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } })
    expect(service.listCalls).toHaveLength(0)
  })
})

describe('follows router — 挂载不越界', () => {
  /**
   * 回归：本 router 挂载在**根路径** `/`（两个端点没有共同前缀）。若中间件写成
   * `router.use('*', …)`，Hono 会把它提升成父 app 的全局中间件 —— 连 `/health` 都会 401
   * （实测：`bun test apps/api/src/app.test.ts` 的 health 用例由 200 变 401）。
   * 这条把「未知路径不受影响」钉在这里，不再依赖需要 Postgres 的 app 级用例。
   */
  test('挂到根路径后，无关路径（/health）不受中间件影响', async () => {
    const service = fakeService()
    const root = new Hono()
    root.route('/', createFollowsRouter({ service, getUserId: () => undefined }))
    root.get('/health', (c) => c.json({ status: 'ok' }))

    const res = await root.request('/health')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('follows router — GET /me/following', () => {
  test('返回分页响应，limit 缺省为 20', async () => {
    const service = fakeService()
    const res = await buildApp(service).request('/me/following')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(page)
    expect(service.listCalls).toEqual([{ userId: VIEWER, query: { limit: 20 } }])
  })

  test('limit / cursor 透传给 service', async () => {
    const service = fakeService()
    await buildApp(service).request('/me/following?limit=5&cursor=abc')
    expect(service.listCalls).toEqual([{ userId: VIEWER, query: { limit: 5, cursor: 'abc' } }])
  })

  test('非法 limit → 422 VALIDATION_FAILED，且不打 service', async () => {
    const service = fakeService()
    const res = await buildApp(service).request('/me/following?limit=0')

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    expect(service.listCalls).toHaveLength(0)
  })
})

describe('follows router — /users/:id/follow', () => {
  test('GET 状态：路径 id 解码后传给 service', async () => {
    const service = fakeService()
    const res = await buildApp(service).request(`/users/${TARGET_PUBLIC}/follow`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state)
    expect(service.stateCalls).toEqual([{ viewerId: VIEWER, targetId: TARGET }])
  })

  test('POST 关注 / DELETE 取关都回状态', async () => {
    const service = fakeService()
    const app = buildApp(service)

    const post = await app.request(`/users/${TARGET_PUBLIC}/follow`, { method: 'POST' })
    expect(post.status).toBe(200)
    expect(await post.json()).toEqual({ following: true, mutual: false })

    const del = await app.request(`/users/${TARGET_PUBLIC}/follow`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ following: false, mutual: false })
  })

  test('非法路径 id → 404 USER_NOT_FOUND，且不打 service', async () => {
    const service = fakeService()
    const res = await buildApp(service).request('/users/not-a-user-id/follow')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'USER_NOT_FOUND', message: '用户不存在或不可见' },
    })
    expect(service.stateCalls).toHaveLength(0)
  })

  test('service 的 404 / 422 原样转成错误信封', async () => {
    const notFound = fakeService({
      async getState() {
        throw new FollowServiceError(404, 'USER_NOT_FOUND', '用户不存在或不可见')
      },
    })
    const res404 = await buildApp(notFound).request(`/users/${TARGET_PUBLIC}/follow`)
    expect(res404.status).toBe(404)
    expect(await res404.json()).toMatchObject({ error: { code: 'USER_NOT_FOUND' } })

    const self = fakeService({
      async follow() {
        throw new FollowServiceError(422, 'CANNOT_FOLLOW_SELF', '不能关注自己')
      },
    })
    const res422 = await buildApp(self).request(`/users/${TARGET_PUBLIC}/follow`, {
      method: 'POST',
    })
    expect(res422.status).toBe(422)
    expect(await res422.json()).toEqual({
      error: { code: 'CANNOT_FOLLOW_SELF', message: '不能关注自己' },
    })
  })
})
