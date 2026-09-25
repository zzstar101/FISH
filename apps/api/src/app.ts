import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import { messageDtoSchema } from '@fish/contracts/chat/schema'
import { errorBody } from '@fish/contracts/system/error'
import { HealthResponseSchema } from '@fish/contracts/system/health'
import { createDb } from '@fish/db/client'
import type { AiPolishEnv, MailTransportEnv, MeetupTokenEnv, ServerEnv } from '@fish/shared/env'
import { loadAiPolishEnv, loadMeetupTokenEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { createAdminModule } from './modules/admin/module'
import { createAiPolishModule } from './modules/ai/module'
import {
  createDevEmailVerificationProvider,
  createResendEmailVerificationProvider,
} from './modules/auth/email-providers'
import { createAuthModule } from './modules/auth/router'
import { createVerificationService } from './modules/auth/verification-service'
import { createCommentsRouter } from './modules/comments/router'
import { createCommentService } from './modules/comments/service'
import { createSqlCommentStore } from './modules/comments/store'
import { createConversationsRouter } from './modules/conversations/router'
import { createConversationService } from './modules/conversations/service'
import { createSqlConversationStore } from './modules/conversations/store'
import { createRestrictionGuard } from './modules/governance/guard'
import { createGovernanceService } from './modules/governance/service'
import { createSqlGovernanceStore } from './modules/governance/store'
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
import { createUploadService } from './modules/uploads/service'
import { createBunS3MediaStorage } from './modules/uploads/storage'
import { createUsersRouter } from './modules/users/router'
import { createPublicUserService } from './modules/users/service'
import { createSqlPublicUserStore } from './modules/users/store'
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
  /** 面交码签名密钥（#70）：API-only（worker 不做 HMAC），index.ts 用 loadMeetupTokenEnv 校验。 */
  meetupEnv: MeetupTokenEnv = loadMeetupTokenEnv(),
  /** AI 润色上游配置（#141）：API-only，index.ts 用 loadAiPolishEnv 校验（transport 无默认值）。 */
  aiEnv: AiPolishEnv = loadAiPolishEnv(),
  /**
   * 微信身份配置（#86 评审 P1）：API-only，index.ts 用 loadWechatEnv 校验。
   * transport 无默认值（off/stub/live），生产禁 stub；`off` 时登录/绑定入口 503 关闭。
   * 测试传 `{ transport: 'stub' }` 显式开启；不传即 off，不会静默降级。
   */
  wechatEnv: import('@fish/shared/env').WechatEnv = { transport: 'off' },
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
    wechat: wechatEnv,
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

  // #73 治理半场 PR3：写入口守卫 + 治理 service 在建库时创建一次。
  //
  // 守卫做成中间剂注入而不是各 service 自查，是为了让「哪些写入口受限制保护」可在接线层
  // 一眼看全（本文件里每个 `guard:` 就是一处）；漏挂一个 router 是显眼的遗漏，
  // 而藏进 service 内部则要逐个读业务代码才能确认覆盖面。
  //
  // `user_restrictions` 每次请求按 (user, type, status) 查一行，靠
  // `user_restrictions_user_type_status_idx`；两个作用域的差异见 guard.ts。
  const governanceStore = createSqlGovernanceStore(db)
  const restrictionGuard = createRestrictionGuard({ store: governanceStore })
  const governanceService = createGovernanceService({ db, store: governanceStore })

  // #6：`GET /listings*` 匿名可用，写接口在 router 内逐路由挂 requireAuth（读路径不能整体 401）。
  app.route(
    '/listings',
    createListingsRouter({
      service: createListingService({ store: createSqlListingStore(db), storage }),
      requireAuth: auth.requireAuth,
      resolveViewerId: auth.resolveViewerId,
      guard: restrictionGuard,
    }),
  )
  // 上传域实例只建一次：#86 B 的头像写入复用同一个 `confirm`（归属前缀 + 对象已上传 +
  // 格式/大小），发布商品与改头像的失败码与文案因此不可能漂移。
  const uploadService = createUploadService({ storage })
  app.route(
    '/uploads',
    createUploadsRouter({
      storage,
      requireAuth: auth.requireAuth,
      service: uploadService,
      guard: restrictionGuard,
    }),
  )

  // 留言 / 评论（#111）：挂根路径，因为三个端点跨 `/listings/:id/comments` 与
  // `/comments/:id/replies`（路径常量在 `@fish/contracts/comments/routes`）。
  // 读接口匿名可用、写接口逐路由挂 requireAuth（与 listings 同一分界）。
  app.route(
    '/',
    createCommentsRouter({
      service: createCommentService({ store: createSqlCommentStore(db) }),
      requireAuth: auth.requireAuth,
      guard: restrictionGuard,
    }),
  )

  // 公开用户主页（#122）：两个端点都是**匿名可读**的公开读模型，所以整条不挂 requireAuth
  // （他人主页对未登录访客也要能看，与 listings 的「读公开、写必须登录」同一条分界；
  // 本域没有写接口）。只读已合并的 users / listings / transactions 表，不调用其他 Domain API
  // （与 profile 同一取舍），storage 复用同一实例：在售卡片的封面 URL 与 feed / 详情必须同一套拼法。
  // 挂根路径，因为两个端点都在 `/users/:userId/...` 之下（路径常量见 `@fish/contracts/users/routes`）。
  app.route(
    '/',
    createUsersRouter({
      service: createPublicUserService({ store: createSqlPublicUserStore(db), storage }),
    }),
  )

  // 个人中心（#12 读 / #86 B 写）：读是一个聚合接口，直接查已合并的 listings/wishes/
  // transactions 表，不调用其他 Domain API。user 块取 requireAuth 写入的 Me（avatarUrl
  // 脏值回退在 auth 的 toMe 内完成），storage 复用同一实例拼封面 URL；#86 B 新增的
  // `PATCH /profile`（改昵称 / 头像）同样只写 users 表，头像校验借用上传域的 confirm。
  app.route(
    '/profile',
    createProfileRouter({
      service: createProfileService({
        store: createSqlProfileStore(db),
        storage,
        uploads: uploadService,
      }),
      requireAuth: auth.requireAuth,
      guard: restrictionGuard,
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
    guard: restrictionGuard,
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
      service: createConversationService({
        store: conversationStore,
        storage,
        // 读位推进后推给会话双方的全部在线连接（#149）：与 message.new 同一通道，
        // 客户端按 readerId 区分「自己读的」与「对方读的」。
        onRead: (participants, event) => {
          hub.pushToUsers([participants.buyerId, participants.sellerId], {
            type: 'conversation.read',
            conversationId: event.conversationId,
            readerId: event.readerId,
            readAt: event.readAt,
          })
        },
      }),
      requireAuth: auth.requireAuth,
      guard: restrictionGuard,
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
      guard: restrictionGuard,
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
      guard: restrictionGuard,
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
  // #70：面交交易码四端点同挂这里，meetupSecret 用于凭证的 HMAC 存储（明文不落库）。
  app.route(
    '/transactions',
    createTransactionsRouter({
      service: createTransactionService({
        store: createSqlTransactionStore(db),
        messages: createSqlMessageStore(db),
        storage,
        meetupSecret: meetupEnv.MEETUP_TOKEN_SECRET,
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
      guard: restrictionGuard,
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

  // 商品描述 AI 润色（#141）：单个端点 `POST /ai/polish-candidates`，整体要求登录
  // （未登录 401，不给匿名者烧配额）。装配在 modules/ai 内，这里只接线；AI 的上游密钥
  // 只经 aiEnv 注入本进程，worker 拿不到。
  const ai = createAiPolishModule({
    db,
    requireAuth: auth.requireAuth,
    env: aiEnv,
    guard: restrictionGuard,
  })
  app.route('/', ai.router)

  // 管理后台（#73）：与普通用户页面 / 普通用户 API 路由隔离（设计 §2）。
  // 挂载点为根级 `/admin`；requireAuth（401）与 requireAdmin（403）两道守卫在 admin
  // router 内部 `use('*')` 应用，覆盖全部 `/admin/*` 入口，普通用户无法靠改前端状态绕过。
  const admin = createAdminModule({
    db,
    storage,
    requireAuth: auth.requireAuth,
    governance: governanceService,
  })
  app.route('/admin', admin.router)

  // 用户端举报（#73）：所有入口都要登录——匿名举报无法追溯，且 reports.reporter_id 非空。
  // 用户端与 Admin 端共用同一个 reports service 实例（见 admin/module.ts）：用户提交后
  // 立刻能在管理队列里查到。写完要求登录用户：`GET /reports/mine` 同样不暴露给匿名。
  app.use('/reports/*', auth.requireAuth)
  app.route('/reports', admin.reportsRouter)

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
