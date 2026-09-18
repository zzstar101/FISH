import { describe, expect, test } from 'bun:test'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { createRequireAdmin } from './middleware'
import type { AdminStore } from './store'

/** 先往 context 写入 userId（模拟 requireAuth 的结果），再测 requireAdmin。 */
function buildApp(isAdmin: (userId: string) => Promise<boolean>) {
  const requireAdmin = createRequireAdmin({ store: { isAdmin } as Pick<AdminStore, 'isAdmin'> })
  const app = new Hono<{ Variables: AuthVariables }>()
  const injectUserId: MiddlewareHandler<{ Variables: AuthVariables }> = (c, next) => {
    c.set('userId', '01930000-0000-7000-8000-00000000000a')
    return next()
  }
  app.use('*', injectUserId)
  app.use('*', requireAdmin)
  app.get('/admin/me', (c) => c.json({ ok: true }, 200))
  return app
}

describe('requireAdmin', () => {
  test('let an ADMIN through', async () => {
    const app = buildApp(async () => true)
    const res = await app.request('/admin/me')
    expect(res.status).toBe(200)
  })

  test('returns stable FORBIDDEN / 403 for a non-admin', async () => {
    const app = buildApp(async () => false)
    const res = await app.request('/admin/me')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: '无管理权限' } })
  })

  test('rolls back to 401 UNAUTHENTICATED when no userId is present (defense in depth)', async () => {
    const requireAdmin = createRequireAdmin({ store: { isAdmin: async () => true } })
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', requireAdmin)
    app.get('/admin/me', (c) => c.json({ ok: true }, 200))
    const res = await app.request('/admin/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } })
  })
})
