import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { Hono } from 'hono'
import type { AuthVariables } from './middleware'
import { requirePhoneBound } from './require-phone'

function appFor(me: Pick<Me, 'phoneBound'>) {
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', async (c, next) => {
    c.set('me', me as Me)
    await next()
  })
  app.post('/publish', requirePhoneBound, (c) => c.json({ ok: true }, 201))
  return app
}

describe('requirePhoneBound（#514）', () => {
  test('未绑定手机号：403 PHONE_REQUIRED，不进入后续处理', async () => {
    const res = await appFor({ phoneBound: false }).request('/publish', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { code: 'PHONE_REQUIRED', message: '发布前请先绑定手机号' },
    })
  })

  test('已绑定手机号：放行', async () => {
    const res = await appFor({ phoneBound: true }).request('/publish', { method: 'POST' })
    expect(res.status).toBe(201)
  })
})
