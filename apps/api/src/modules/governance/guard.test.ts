import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createRestrictionGuard, type RestrictionVariables } from './guard'
import type { GovernanceStore, RestrictionRow, RestrictionScope } from './store'

/**
 * 守卫的作用域映射（评审盲区：router 测试里 8 个替身守卫一律放行，
 * 所以「把 publish 挂成了 write」这类错误会让所有测试仍然全绿）。
 *
 * 这里直接拿假 store 验证每个 scope 分别认哪些限制类型，与真实数据无关。
 */
describe('写入口守卫的作用域映射', () => {
  const buildApp = (activeTypes: RestrictionRow['type'][]) => {
    const store = {
      // 与 store.ts 的 SCOPE_TYPES 同口径：publish 认两种限制，write 只认 BAN。
      hasActiveRestriction: async (_userId: string, scope: RestrictionScope) =>
        scope === 'publish'
          ? activeTypes.includes('PUBLISH_RESTRICT') || activeTypes.includes('BAN')
          : activeTypes.includes('BAN'),
    } as Pick<GovernanceStore, 'hasActiveRestriction'>

    const guard = createRestrictionGuard({ store })
    const app = new Hono<{ Variables: RestrictionVariables }>()
    app.use('*', async (c, next) => {
      c.set('userId', '01940000-0000-7000-8000-0000000000b1')
      await next()
    })
    app.post('/publish', guard.publish, (c) => c.json({ ok: true }))
    app.post('/write', guard.write, (c) => c.json({ ok: true }))
    return app
  }

  test('限制发布挡发布入口，但留言 / 聊天照旧', async () => {
    const app = buildApp(['PUBLISH_RESTRICT'])
    expect((await app.request('/publish', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/write', { method: 'POST' })).status).toBe(200)
  })

  test('封禁同时挡发布与留言 / 聊天', async () => {
    const app = buildApp(['BAN'])
    expect((await app.request('/publish', { method: 'POST' })).status).toBe(403)
    expect((await app.request('/write', { method: 'POST' })).status).toBe(403)
  })

  test('没有任何生效限制时两个入口都放行', async () => {
    const app = buildApp([])
    expect((await app.request('/publish', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/write', { method: 'POST' })).status).toBe(200)
  })

  test('context 里没有 userId 时返回 401，而不是放行', async () => {
    const guard = createRestrictionGuard({
      store: { hasActiveRestriction: async () => false },
    })
    const app = new Hono<{ Variables: RestrictionVariables }>()
    app.post('/publish', guard.publish, (c) => c.json({ ok: true }))
    const res = await app.request('/publish', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })
})
