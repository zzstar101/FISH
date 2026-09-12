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
import { createListingsRouter } from './modules/listings/router'
import { createListingService } from './modules/listings/service'
import { createSqlListingStore } from './modules/listings/store'
import { createMatchingRouter } from './modules/matching/router'
import { createMatchingService } from './modules/matching/service'
import { createSqlMatchingStore } from './modules/matching/store'
import { createUploadsRouter } from './modules/uploads/router'
import { createBunS3MediaStorage } from './modules/uploads/storage'
import { createDbWishMatchQueue } from './modules/wishes/match-queue'
import { createWishesRouterFromDb } from './modules/wishes/router'
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

  // 对象存储实例在接线层创建一次，注入给 uploads（签发直传）与 listings（读响应拼 URL）：
  // 「公开 URL 怎么拼」只允许有一个实现（#6 契约 §7.8）。
  const storage = createBunS3MediaStorage({
    client: new Bun.S3Client({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
    }),
    publicUrlBase: env.S3_PUBLIC_URL,
  })

  // #6：`GET /listings*` 匿名可用，写接口在 router 内逐路由挂 requireAuth（读路径不能整体 401）。
  app.route(
    '/listings',
    createListingsRouter({
      service: createListingService({ store: createSqlListingStore(db), storage }),
      requireAuth: auth.requireAuth,
      resolveViewerId: auth.resolveViewerId,
    }),
  )
  app.route('/uploads', createUploadsRouter({ storage, requireAuth: auth.requireAuth }))

  // #8：匹配读接口全部要求登录且目标必须是本人的（契约 §0.2），所以整条路由挂 requireAuth。
  // `storage` 复用同一个实例：匹配结果里的商品卡片与 feed / 详情必须是同一套 URL 拼法。
  app.route(
    '/matches',
    createMatchingRouter({
      service: createMatchingService({ store: createSqlMatchingStore(db), storage }),
      requireAuth: auth.requireAuth,
    }),
  )

  // 愿望模块（#7）：先过认证守卫，再进 router；router 的 getUserId 只读守卫写入的可信 context，
  // 不读请求头。创建/重放愿望时用真实 DB 队列写 MATCH_WISH job（消费方归 #8/#13，与本 Issue 解耦）。
  app.use('/api/wishes/*', auth.requireAuth)
  app.route(
    '/api/wishes',
    createWishesRouterFromDb(db, {
      getUserId: (c) => c.get('userId'),
      matchQueue: createDbWishMatchQueue(db),
    }),
  )

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
