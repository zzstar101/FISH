import { HealthResponseSchema } from '@fish/contracts/system/health'
import { createDb } from '@fish/db/client'
import type { ServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { API_VERSION } from './version'
import { upgradeWebSocket } from './ws'

export function createApp(env: ServerEnv) {
  const db = createDb(env.DATABASE_URL)
  const app = new Hono()

  app.use('*', cors({ origin: env.WEB_ORIGIN }))

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
