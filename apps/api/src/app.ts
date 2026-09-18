import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import { messageDtoSchema } from '@fish/contracts/chat/schema'
import { errorBody } from '@fish/contracts/system/error'
import { HealthResponseSchema } from '@fish/contracts/system/health'
import { createDb } from '@fish/db/client'
import type { MailTransportEnv, ServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import {
  createDevEmailVerificationProvider,
  createResendEmailVerificationProvider,
} from './modules/auth/email-providers'
import { createAuthModule } from './modules/auth/router'
import { createVerificationService } from './modules/auth/verification-service'
import { createConversationsRouter } from './modules/conversations/router'
import { createConversationService } from './modules/conversations/service'
import { createSqlConversationStore } from './modules/conversations/store'
import { createListingsRouter } from './modules/listings/router'
import { createListingService } from './modules/listings/service'
import { createSqlListingStore } from './modules/listings/store'
import { createMatchingRouter } from './modules/matching/router'
import { createMatchingService } from './modules/matching/service'
import { createSqlMatchingStore } from './modules/matching/store'
import { createMediaRouter } from './modules/messages/media-router'
import { createMediaMessageService } from './modules/messages/media-service'
import { createSqlMediaMessageStore } from './modules/messages/media-store'
import { createMessagesRouter } from './modules/messages/router'
import { createMessageService } from './modules/messages/service'
import { createSqlMessageStore } from './modules/messages/store'
import { createNotificationsRouter } from './modules/notifications/router'
import { createNotificationService } from './modules/notifications/service'
import { createSqlNotificationStore } from './modules/notifications/store'
import { createProfileRouter } from './modules/profile/router'
import { createProfileService } from './modules/profile/service'
import { createSqlProfileStore } from './modules/profile/store'
import { createConnectionHub } from './modules/realtime/hub'
import { createRealtimeRouter } from './modules/realtime/router'
import { createTransactionsRouter } from './modules/transactions/router'
import { createTransactionService } from './modules/transactions/service'
import { createSqlTransactionStore } from './modules/transactions/store'
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

export function createApp(
  env: ServerEnv,
  /** 邮件 transport（#68）：调用方显式传入（index.ts 用 loadMailTransportEnv 从 env 校验）。 */
  mailEnv: MailTransportEnv = { transport: 'outbox' },
) {
  const db = createDb(env.DATABASE_URL)
  const app = new Hono()

  app.use('*', cors({ origin: env.WEB_ORIGIN }))

  // 认证模块的装配在 modules/auth 内，这里只负责接线（#3；#68 改为邮箱验证码子域）。
  // secureCookie 由 WEB_ORIGIN 的 scheme 推导：本地 http 加 Secure 会让 cookie 直接失效。
  //
  // #68：注册一律 UNVERIFIED；认证走校园邮箱验证码（Provider 见 verification-provider.ts，
  // dev 实现写 .dev/mail-outbox.jsonl，不进日志）。接入真实 SMTP / CAS 时只换 Provider 实现。
  const auth = createAuthModule({
    db,
    verification: createVerificationService({
      db,
      // 邮件里的图片必须绝对地址；logo 由 Web 站点托管（apps/web/public/logo.png）。
      // transport 由 MAIL_TRANSPORT 显式选择（无默认值，缺配置启动失败，不静默降级）。
      provider:
        mailEnv.transport === 'resend'
          ? createResendEmailVerificationProvider(
              { apiKey: mailEnv.resendApiKey, from: mailEnv.resendFrom },
              { logoUrl: `${env.WEB_ORIGIN}/logo.png` },
            )
          : createDevEmailVerificationProvider(undefined, {
              logoUrl: `${env.WEB_ORIGIN}/logo.png`,
            }),
    }),
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

  // 个人中心（#12）：单个只读聚合接口，直接查已合并的 listings/wishes/transactions 表，
  // 不调用其他 Domain API、不承担写操作（Issue 的并行原则）。user 块取 requireAuth
  // 写入的 Me（campus 脏值回退在 auth 内完成），storage 复用同一实例拼封面 URL。
  app.route(
    '/profile',
    createProfileRouter({
      service: createProfileService({ store: createSqlProfileStore(db), storage }),
      requireAuth: auth.requireAuth,
    }),
  )

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
  //
  // 挂载点是与 listings / matches 一致的**根级** `/wishes`：本仓约定是“API 路由保持根级，
  // Web 写相对路径 `/api/...`、由 Vite 代理去掉前缀”（`docs/architecture.md` §5.1）。
  //
  // 历史：`WISH_ROUTES.base` 曾是 `/api/wishes`（把浏览器前缀写进了 API 路径）。#52 为不打断
  // 当时的调用方并存过 `/api/wishes` 过渡别名；#53 把常量收敛到根级后，别名已删除
  //（`apps/api/src/app.wishes.test.ts` 有一条断言钉住它不会被无意间重新引入）。
  const wishes = createWishesRouterFromDb(db, {
    getUserId: (c) => c.get('userId'),
    matchQueue: createDbWishMatchQueue(db),
  })
  app.use('/wishes/*', auth.requireAuth)
  app.route('/wishes', wishes)

  // 聊天模块（#9）：会话与消息两条 router 并列挂到 /conversations（messages 只提供
  // /:id/messages 两个端点）。全部要求登录，整条挂 requireAuth；storage 复用同一实例，
  // 会话商品卡的封面 URL 与 feed/详情同一套拼法。挂载点用根路径 /conversations，
  // 与 listings/matching 一致（Web 侧 /api 前缀由 Vite 代理剥离；CHAT_ROUTES 契约注释同源）。
  const conversationStore = createSqlConversationStore(db)
  // 实时推送（#9 契约冻结语义③）：消息服务先落库，再经 hub 推给会话双方的全部在线连接。
  const hub = createConnectionHub()
  app.route(
    '/conversations',
    createConversationsRouter({
      service: createConversationService({ store: conversationStore, storage }),
      requireAuth: auth.requireAuth,
    }),
  )
  app.route(
    '/conversations',
    createMediaRouter({
      service: createMediaMessageService({
        store: createSqlMediaMessageStore(db),
        storage,
        mediaUrl: (conversationId, mediaId) =>
          `/api/conversations/${conversationId}/media/${mediaId}`,
        onMediaCreated: (participants, media) => {
          hub.pushMediaToUsers([participants.buyerId, participants.sellerId], {
            type: 'media.new',
            conversationId: media.conversationId,
            media,
          })
        },
      }),
      storage,
      requireAuth: auth.requireAuth,
    }),
  )
  app.route(
    '/conversations',
    createMessagesRouter({
      service: createMessageService({
        store: createSqlMessageStore(db),
        onMessageCreated: (participants, message) => {
          hub.pushToUsers([participants.buyerId, participants.sellerId], {
            type: 'message.new',
            conversationId: message.conversationId,
            message,
          })
        },
      }),
      requireAuth: auth.requireAuth,
    }),
  )

  // 业务实时通道：upgrade 鉴权与 HTTP requireAuth 同一套 cookie + session（语义①②）。
  // 路径常量在 chat 契约（/ws/chat），echo 冒烟入口 /ws 不受影响。
  app.get(
    REALTIME_WS_PATH,
    createRealtimeRouter({
      hub,
      resolveUserId: auth.resolveViewerId,
      upgradeWebSocket,
    }),
  )

  // 交易模块（#11）：提案/接受/拒绝以 SYSTEM 消息进会话（经 messages store 直写），
  // 写入后经同一 hub 推送（与文本消息同一条 message.new 通道）。整条挂 requireAuth。
  app.route(
    '/transactions',
    createTransactionsRouter({
      service: createTransactionService({
        store: createSqlTransactionStore(db),
        messages: createSqlMessageStore(db),
        storage,
        onSystemMessage: (participants, message) => {
          hub.pushToUsers([participants.buyerId, participants.sellerId], {
            type: 'message.new',
            conversationId: message.conversation_id,
            message: messageDtoSchema.parse({
              id: message.id,
              conversationId: message.conversation_id,
              senderId: message.sender_id,
              sender: null,
              type: message.type,
              content: message.content,
              createdAt: new Date(message.created_at).toISOString(),
            }),
          })
        },
      }),
      requireAuth: auth.requireAuth,
    }),
  )

  // 通知（#23）：三个端点全是本人数据，没有匿名路径，与 /wishes 同一挂法——先挂认证守卫，
  // 再进 router；router 的 getUserId 只读守卫写入的可信 context，不读请求头。
  // 挂载点是根级 `/notifications`（`NOTIFICATION_ROUTES.base`），与 listings/wishes/matches 一致。
  app.use('/notifications/*', auth.requireAuth)
  app.route(
    '/notifications',
    createNotificationsRouter({
      service: createNotificationService({ store: createSqlNotificationStore(db) }),
      getUserId: (c) => c.get('userId'),
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
