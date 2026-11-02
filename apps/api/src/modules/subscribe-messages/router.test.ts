import { describe, expect, test } from 'bun:test'
import type { SubscribeMessageConfig } from '@fish/contracts/subscribe-messages/schema'
import { type Context, Hono, type Next } from 'hono'
import { createSubscribeMessagesRouter } from './router'
import { SubscribeMessageError, type SubscribeMessageService } from './service'

/**
 * 两个端点的 HTTP 语义（#462）：配置匿名可读、上报要登录且过写守卫、未开通时 503。
 *
 * 用假 service：这里钉的是状态码与中间件顺序，记账口径在 `service.test.ts`、
 * SQL 在 `store.test.ts`。
 */

const VIEWER = '01930000-0000-7000-8000-00000000000a'

const enabledConfig: SubscribeMessageConfig = {
  templates: { CHAT: 'tmpl_chat', TX: null, REVIEW: 'tmpl_review' },
}

function fakeService(overrides: Partial<SubscribeMessageService> = {}): SubscribeMessageService {
  return {
    config: () => enabledConfig,
    async reportGrants() {
      return { remaining: { CHAT: 1, TX: 0, REVIEW: 2 } }
    },
    ...overrides,
  }
}

function buildApp(
  service: SubscribeMessageService,
  options: { authed?: boolean; writeGuard?: 'allow' | 'blocked' } = {},
) {
  const authed = options.authed ?? true
  const root = new Hono()
  root.route(
    '/',
    createSubscribeMessagesRouter({
      service,
      // 模拟 auth.requireAuth：未登录直接 401（真实实现还做 cookie/session 校验）
      requireAuth: async (c: Context, next: Next) => {
        if (!authed) return c.json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401)
        c.set('userId', VIEWER)
        await next()
      },
      guard: {
        write: async (c: Context, next: Next) => {
          if (options.writeGuard === 'blocked') {
            return c.json({ error: { code: 'USER_RESTRICTED', message: '账号被限制' } }, 403)
          }
          await next()
        },
      } as never,
    }),
  )
  return root
}

const GRANTS_PATH = '/me/subscribe-messages/grants'
const CONFIG_PATH = '/subscribe-messages/config'

describe('GET /subscribe-messages/config', () => {
  test('匿名可读，原样返回三个 kind 的模板 ID 或 null', async () => {
    const app = buildApp(fakeService(), { authed: false })
    const res = await app.request(CONFIG_PATH)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(enabledConfig)
  })
})

describe('POST /me/subscribe-messages/grants', () => {
  test('未登录 → 401', async () => {
    const app = buildApp(fakeService(), { authed: false })
    const res = await app.request(GRANTS_PATH, {
      method: 'POST',
      body: JSON.stringify({ grants: [{ kind: 'CHAT', status: 'accept' }] }),
    })
    expect(res.status).toBe(401)
  })

  test('被限制的账号 → 403（写守卫），且不记账', async () => {
    let called = false
    const app = buildApp(
      fakeService({
        async reportGrants() {
          called = true
          return { remaining: { CHAT: 0, TX: 0, REVIEW: 0 } }
        },
      }),
      { writeGuard: 'blocked' },
    )
    const res = await app.request(GRANTS_PATH, {
      method: 'POST',
      body: JSON.stringify({ grants: [{ kind: 'CHAT', status: 'accept' }] }),
    })
    expect(res.status).toBe(403)
    expect(called).toBe(false)
  })

  test('请求体不合法 → 422，不触达 service', async () => {
    let called = false
    const app = buildApp(
      fakeService({
        async reportGrants() {
          called = true
          return { remaining: { CHAT: 0, TX: 0, REVIEW: 0 } }
        },
      }),
    )

    for (const body of [
      'not-json',
      '{}',
      JSON.stringify({ grants: [] }),
      JSON.stringify({ grants: [{ kind: 'MATCH', status: 'accept' }] }),
      JSON.stringify({ grants: [{ kind: 'CHAT', status: 'accept' }], extra: 1 }),
    ]) {
      const res = await app.request(GRANTS_PATH, { method: 'POST', body })
      expect(res.status).toBe(422)
    }
    expect(called).toBe(false)
  })

  test('合法上报 → 200 与各 kind 剩余次数；未知 status 当拒绝（不 422）', async () => {
    const seen: unknown[] = []
    const app = buildApp(
      fakeService({
        async reportGrants(userId, report) {
          seen.push({ userId, report })
          return { remaining: { CHAT: 1, TX: 0, REVIEW: 0 } }
        },
      }),
    )
    const res = await app.request(GRANTS_PATH, {
      method: 'POST',
      body: JSON.stringify({ grants: [{ kind: 'CHAT', status: 'something-new' }] }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ remaining: { CHAT: 1, TX: 0, REVIEW: 0 } })
    // 未知值收敛成 reject 而不是整包 422（契约用 `.catch('reject')`）
    expect(seen).toEqual([
      { userId: VIEWER, report: { grants: [{ kind: 'CHAT', status: 'reject' }] } },
    ])
  })

  test('能力未开通 → 503 SUBSCRIBE_MESSAGES_DISABLED（不是静默记账）', async () => {
    const app = buildApp(
      fakeService({
        async reportGrants() {
          throw new SubscribeMessageError(
            'SUBSCRIBE_MESSAGES_DISABLED',
            '微信订阅消息暂未开通',
            503,
          )
        },
      }),
    )
    const res = await app.request(GRANTS_PATH, {
      method: 'POST',
      body: JSON.stringify({ grants: [{ kind: 'CHAT', status: 'accept' }] }),
    })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: { code: 'SUBSCRIBE_MESSAGES_DISABLED', message: '微信订阅消息暂未开通' },
    })
  })
})
