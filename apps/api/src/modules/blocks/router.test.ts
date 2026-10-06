import { describe, expect, test } from 'bun:test'
import type { BlockState, MyBlocksQuery, MyBlocksResponse } from '@fish/contracts/blocks/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { Hono } from 'hono'
import { createBlocksRouter } from './router'
import { type BlockService, BlockServiceError } from './service'

const VIEWER = '01930000-0000-7000-8000-00000000000a'
const TARGET = '01930000-0000-7000-8000-00000000000b'
const TARGET_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, TARGET)

const state: BlockState = { blocked: true }
const page: MyBlocksResponse = {
  items: [
    {
      id: TARGET_PUBLIC,
      nickname: '林一',
      avatarUrl: null,
      authStatus: 'VERIFIED',
      blockedAt: '2026-10-05T02:00:00.000Z',
    },
  ],
  nextCursor: null,
}

function fakeService(overrides: Partial<BlockService> = {}): BlockService & {
  listCalls: { userId: string; query: MyBlocksQuery }[]
  relationCalls: { viewerId: string; targetId: string; op: string }[]
} {
  const listCalls: { userId: string; query: MyBlocksQuery }[] = []
  const relationCalls: { viewerId: string; targetId: string; op: string }[] = []
  return {
    listCalls,
    relationCalls,
    async listMyBlocks(userId, query) {
      listCalls.push({ userId, query })
      return page
    },
    async getState(viewerId, targetId) {
      relationCalls.push({ viewerId, targetId, op: 'get' })
      return state
    },
    async block(viewerId, targetId) {
      relationCalls.push({ viewerId, targetId, op: 'block' })
      return { blocked: true }
    },
    async unblock(viewerId, targetId) {
      relationCalls.push({ viewerId, targetId, op: 'unblock' })
      return { blocked: false }
    },
    ...overrides,
  }
}

/**
 * 模拟 `app.ts` 的接线：`getUserId` 读的是 requireAuth 写入的可信 context。
 */
function buildApp(service: BlockService, viewerId: string | null = VIEWER) {
  const root = new Hono()
  root.route('/', createBlocksRouter({ service, getUserId: () => viewerId ?? undefined }))
  return root
}

describe('blocks router — 认证兜底', () => {
  test('拿不到可信 userId → 401 UNAUTHENTICATED，且不打 service', async () => {
    const service = fakeService()
    const res = await buildApp(service, null).request('/me/blocks')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } })
    expect(service.listCalls).toHaveLength(0)
  })

  test('关系路径同样失败关闭：401 且不打 service', async () => {
    const service = fakeService()
    const res = await buildApp(service, null).request(`/users/${TARGET_PUBLIC}/block`, {
      method: 'POST',
    })
    expect(res.status).toBe(401)
    expect(service.relationCalls).toHaveLength(0)
  })
})

describe('blocks router — 挂载不越界', () => {
  /**
   * 回归：本 router 挂载在**根路径** `/`（两个端点没有共同前缀）。若中间件写成
   * `router.use('*', …)`，Hono 会把它提升成父 app 的全局中间件 —— 连 `/health` 都会 401。
   * 这条把「未知路径不受影响」钉在这里（follows/router.test.ts 同款）。
   */
  test('挂到根路径后，无关路径（/health）不受中间件影响', async () => {
    const service = fakeService()
    const root = new Hono()
    root.route('/', createBlocksRouter({ service, getUserId: () => undefined }))
    root.get('/health', (c) => c.json({ status: 'ok' }))

    const res = await root.request('/health')

    expect(res.status).toBe(200)
  })
})

describe('blocks router — /me/blocks', () => {
  test('返回分页响应，limit 缺省为 20', async () => {
    const service = fakeService()
    const res = await buildApp(service).request('/me/blocks')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(page)
    expect(service.listCalls).toEqual([{ userId: VIEWER, query: { limit: 20 } }])
  })

  test('limit / cursor 透传给 service', async () => {
    const service = fakeService()
    await buildApp(service).request('/me/blocks?limit=5&cursor=abc')
    expect(service.listCalls).toEqual([{ userId: VIEWER, query: { limit: 5, cursor: 'abc' } }])
  })

  test('非法 limit → 422 VALIDATION_FAILED，且不打 service', async () => {
    const service = fakeService()
    const res = await buildApp(service).request('/me/blocks?limit=0')

    expect(res.status).toBe(422)
    expect(service.listCalls).toHaveLength(0)
  })
})

describe('blocks router — 关系路径', () => {
  test('GET / POST / DELETE 均把解码后的内部 uuid 交给 service', async () => {
    const service = fakeService()
    const app = buildApp(service)

    expect((await app.request(`/users/${TARGET_PUBLIC}/block`)).status).toBe(200)
    expect((await app.request(`/users/${TARGET_PUBLIC}/block`, { method: 'POST' })).status).toBe(
      200,
    )
    expect((await app.request(`/users/${TARGET_PUBLIC}/block`, { method: 'DELETE' })).status).toBe(
      200,
    )
    expect(service.relationCalls).toEqual([
      { viewerId: VIEWER, targetId: TARGET, op: 'get' },
      { viewerId: VIEWER, targetId: TARGET, op: 'block' },
      { viewerId: VIEWER, targetId: TARGET, op: 'unblock' },
    ])
  })

  test('非法 / 裸 uuid 路径参数 → 404 USER_NOT_FOUND（不给 id 空间探针），且不打 service', async () => {
    const service = fakeService()
    const app = buildApp(service)

    for (const bad of ['3f9d1c2e-0000-4000-8000-000000000000', '1234567890']) {
      const res = await app.request(`/users/${bad}/block`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'USER_NOT_FOUND', message: '用户不存在或不可见' },
      })
    }
    expect(service.relationCalls).toHaveLength(0)
  })

  test('service 的 422 原样转成错误信封（自拉黑）', async () => {
    const service = fakeService({
      async block() {
        throw new BlockServiceError(422, 'CANNOT_BLOCK_SELF', '不能拉黑自己')
      },
    })
    const res = await buildApp(service).request(`/users/${TARGET_PUBLIC}/block`, { method: 'POST' })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: { code: 'CANNOT_BLOCK_SELF', message: '不能拉黑自己' },
    })
  })
})
