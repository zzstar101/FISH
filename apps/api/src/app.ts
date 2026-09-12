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

/**
 * 只输出**脱敏**的错误描述，不打印整个错误对象。
 *
 * Drizzle 的包装错误 message 是两行：第一行 `Failed query: <占位符 SQL>`，第二行 `params: [...]`
 * 才是实参值（注册路径的 params 里含 `student_no` 与 `password_hash`）——所以只取第一行；
 * 栈的首行同样是 `name: message`，因此只保留 `at ` 开头的调用帧。
 */
function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    parts.push(`${current.name}: ${current.message.split('\n')[0] ?? ''}`)
    current = current.cause
  }

  const frames = (error instanceof Error ? error.stack : '')
    ?.split('\n')
    .filter((line) => line.trim().startsWith('at '))
    .slice(0, 10)
    .join('\n')

  return [parts.join(' <- ') || String(error), frames].filter(Boolean).join('\n')
}

export function createApp(env: ServerEnv) {
  const db = createDb(env.DATABASE_URL)
  const app = new Hono()

  app.use('*', cors({ origin: env.WEB_ORIGIN }))

  // 认证模块的装配在 modules/auth 内，这里只负责接线（#3）。
  // secureCookie 由 WEB_ORIGIN 的 scheme 推导：本地 http 加 Secure 会让 cookie 直接失效。
  //
  // ⚠️ 这里接的是 Mock Provider：它对任意未被占用的「12 位、20 开头」学号都返回 VERIFIED。
  // 因此 **`authStatus` 在接入真实教务校验前不能当作可信标识**，#5 的徽章不要拿它当安全依据。
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
    console.error('[api] 未捕获异常', describeError(error))
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
