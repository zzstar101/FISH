import { errorBody } from '@fish/contracts/system/error'
import { HealthResponseSchema } from '@fish/contracts/system/health'
import { createDb } from '@fish/db/client'
import type { ServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { createMockCampusVerificationProvider } from './modules/auth/provider'
import { createAuthModule } from './modules/auth/router'
import { API_VERSION } from './version'
import { upgradeWebSocket } from './ws'

export function createApp(env: ServerEnv) {
  const db = createDb(env.DATABASE_URL)
  const app = new Hono()

  app.use('*', cors({ origin: env.WEB_ORIGIN }))

  // 认证模块的装配在 modules/auth 内，这里只负责接线（#3）。
  // secureCookie 由 WEB_ORIGIN 的 scheme 推导：本地 http 加 Secure 会让 cookie 直接失效。
  const auth = createAuthModule({
    db,
    provider: createMockCampusVerificationProvider(),
    secureCookie: env.WEB_ORIGIN.startsWith('https://'),
  })
  app.route('/auth', auth.router)
  app.get('/me', auth.requireAuth, auth.meHandler)

  // 未捕获异常统一成契约里的错误信封，避免 Hono 默认 HTML / 栈信息外泄；
  // HTTPException（如 404 / 405）保持 Hono 自身语义。
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse()
    console.error('[api] 未捕获异常', error)
    return c.json(errorBody('INTERNAL_ERROR', '服务器内部错误'), 500)
  })

  app.get('/health', async (c) => {
    const startedAt = performance.now()
    let dbStatus: 'up' | 'down' = 'up'
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbStatus = 'down'
    }

    const body = HealthResponseSchema.parse({
      status: dbStatus === 'up' ? 'ok' : 'degraded',
      version: API_VERSION,
      timestamp: new Date().toISOString(),
      db: {
        status: dbStatus,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
    })

    return c.json(body, dbStatus === 'up' ? 200 : 503)
  })

  app.get(
    '/ws',
    upgradeWebSocket(() => ({
      onMessage(event, ws) {
        // 冒烟入口只回显文本帧；二进制帧留给业务实时通道（#9）。
        if (typeof event.data === 'string') ws.send(event.data)
      },
    })),
  )

  return app
}
