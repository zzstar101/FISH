import { describe, expect, test } from 'bun:test'
import type { ProfileResponse } from '@fish/contracts/profile/schema'
import { Hono } from 'hono'
import { UploadServiceError } from '../uploads/service'
import { createProfileRouter } from './router'
import type { ProfileService } from './service'

const profile = {
  user: {
    // 契约的 Me.id 是 z.uuid()：PATCH 回包要过 profileUpdateResponseSchema.parse，
    // fixture 用 'user-1' 会 500（GET 直接回 service 结果，历史上没暴露这一点）。
    id: '01930000-0000-7000-8000-0000000000a1',
    nickname: '小明',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    verifiedAt: '2026-09-12T00:00:00.000Z',
    phoneBound: false,
    maskedPhone: null,
  },
  stats: { activeListings: 1, activeWishes: 1, completedTransactions: 1 },
  listings: [],
  wishes: [],
  transactions: [],
} as unknown as ProfileResponse

const me = profile.user

/**
 * 用例只覆盖自己关心的那个方法，其余给一个能通过的最小实现：接口加方法时
 * 不会每个假实现都挂（#86 B 的 updateProfile 就是这么加进来的）。
 */
function fakeService(overrides: Partial<ProfileService> = {}): ProfileService {
  return {
    getProfile: async () => profile,
    updateProfile: async () => me,
    ...overrides,
  }
}

/**
 * 真 app 里 requireAuth 由每个路由自己挂（apps/api/src/app.ts 注入 `auth.requireAuth`），
 * 这里用外层中间件直接把 Me 塞进上下文，等价于「已登录」。
 */
type TestRoot = Hono<{ Variables: { userId: string; me: unknown } }>

function buildRoot(service: ProfileService): TestRoot {
  const root = new Hono<{ Variables: { userId: string; me: unknown } }>()
  root.use('*', async (c, next) => {
    c.set('userId', 'user-1')
    c.set('me', me)
    await next()
  })
  root.route(
    '/profile',
    createProfileRouter({
      service,
      requireAuth: async (_c, next) => {
        await next()
      },
    }),
  )
  return root
}

const patch = (root: TestRoot, body: unknown) =>
  root.request('/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('profile router', () => {
  test('GET /profile returns the aggregate for the authenticated user', async () => {
    const response = await buildRoot(fakeService()).request('/profile')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(profile)
  })

  test('passes the context Me to the service (user 块不重复查库)', async () => {
    let received: unknown
    const service = fakeService({
      getProfile: async (meArg) => {
        received = meArg
        return profile
      },
    })

    await buildRoot(service).request('/profile')
    expect(received).toEqual(me)
  })
})

describe('PATCH /profile（#86 B：编辑资料）', () => {
  test('昵称与头像 objectKey 解析后原样交给 service，回包是 { user }', async () => {
    let received: unknown
    const service = fakeService({
      updateProfile: async (_me, input) => {
        received = input
        return { ...me, nickname: '新名字' }
      },
    })

    const response = await patch(buildRoot(service), {
      nickname: '新名字',
      avatarObjectKey: 'listings/u1/a.jpg',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ user: { ...me, nickname: '新名字' } })
    expect(received).toEqual({ nickname: '新名字', avatarObjectKey: 'listings/u1/a.jpg' })
  })

  test('空对象 → 422 VALIDATION_FAILED，service 一次都没被调用', async () => {
    let called = 0
    const service = fakeService({
      updateProfile: async () => {
        called += 1
        return me
      },
    })

    const response = await patch(buildRoot(service), {})

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: '请求参数不合法' },
    })
    expect(called).toBe(0)
  })

  test('未知字段被 strictObject 拒掉（campus 已不存在，不能静默吞掉）', async () => {
    const response = await patch(buildRoot(fakeService()), { nickname: '新名字', campus: '肇庆' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
  })

  test('上传域拒绝原样冒泡：状态码/错误码/文案都来自 UploadServiceError', async () => {
    const service = fakeService({
      updateProfile: async () => {
        throw new UploadServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片不属于当前用户')
      },
    })

    const response = await patch(buildRoot(service), { avatarObjectKey: 'listings/u2/b.jpg' })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: { code: 'IMAGE_REFERENCE_INVALID', message: '图片不属于当前用户' },
    })
  })
})
