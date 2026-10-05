import { BLOCK_ROUTES } from '@fish/contracts/blocks/routes'
import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import {
  RECOMMENDATION_EVENT_RATE_LIMIT,
  RECOMMENDATION_FEED_RATE_LIMIT,
  RECOMMENDATION_RATE_LIMIT_MAX_SUBJECTS,
} from '@fish/contracts/recommendation/observability'
import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import { errorBody } from '@fish/contracts/system/error'
import { HealthResponseSchema } from '@fish/contracts/system/health'
import type { UserPresence } from '@fish/contracts/users/schema'
import { VIEW_HISTORY_ROUTES } from '@fish/contracts/view-history/routes'
import { VISUAL_QUERY_PRESIGN_EXPIRES_SECONDS } from '@fish/contracts/visual/schema'
import { createDb } from '@fish/db/client'
import type {
  AiPolishEnv,
  ContentModerationEnv,
  MailTransportEnv,
  MeetupTokenEnv,
  ServerEnv,
  VisualEmbeddingEnv,
  VisualParseEnv,
} from '@fish/shared/env'
import {
  loadAiPolishEnv,
  loadMeetupTokenEnv,
  loadRecommendationRateLimitEnv,
} from '@fish/shared/env'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createVisualEmbeddingProvider } from '@fish/visual-embedding/providers/factory'
import { STUB_VISUAL_EMBEDDING_MODEL } from '@fish/visual-embedding/providers/stub'
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
import { createBlocksRouter } from './modules/blocks/router'
import { createBlockService } from './modules/blocks/service'
import { createSqlBlockStore } from './modules/blocks/store'
import { createBrandAssetsRouter } from './modules/brand-assets/router'
import { createCommentsRouter } from './modules/comments/router'
import { createCommentService } from './modules/comments/service'
import { createSqlCommentStore } from './modules/comments/store'
import { createConversationsRouter } from './modules/conversations/router'
import { createConversationService } from './modules/conversations/service'
import { createSqlConversationStore } from './modules/conversations/store'
import { createChatWatchersRouter } from './modules/conversations/watchers-router'
import { createChatWatchersService } from './modules/conversations/watchers-service'
import { createFavoritesRouter } from './modules/favorites/router'
import { createFavoriteService } from './modules/favorites/service'
import { createSqlFavoriteStore } from './modules/favorites/store'
import { createFollowsRouter } from './modules/follows/router'
import { createFollowService } from './modules/follows/service'
import { createSqlFollowStore } from './modules/follows/store'
import { createRestrictionGuard } from './modules/governance/guard'
import { createGovernanceService } from './modules/governance/service'
import { createSqlGovernanceStore } from './modules/governance/store'
import { createListingNumberLookup } from './modules/listings/number-lookup'
import { createListingsRouter } from './modules/listings/router'
import { createListingService } from './modules/listings/service'
import { createSqlListingStore } from './modules/listings/store'
import { trustedClientIp } from './modules/listings/trusted-ip'
import { createMatchingRouter } from './modules/matching/router'
import { createMatchingService } from './modules/matching/service'
import { createSqlMatchingStore } from './modules/matching/store'
import { createMediaRouter } from './modules/messages/media-router'
import { createMediaMessageService } from './modules/messages/media-service'
import { createSqlMediaMessageStore } from './modules/messages/media-store'
import { createMessagesRouter } from './modules/messages/router'
import { createMessageService, toMessageDto } from './modules/messages/service'
import { createSqlMessageStore } from './modules/messages/store'
import { createSystemContentProjector } from './modules/messages/system-content'
import { createContentModerationProvider } from './modules/moderation/providers/factory'
import { createNotificationsRouter } from './modules/notifications/router'
import { createNotificationService } from './modules/notifications/service'
import { createSqlNotificationStore } from './modules/notifications/store'
import { writeNotification } from './modules/notifications/writer'
import { createPresenceRegistry } from './modules/presence/presence'
import { createProfileRouter } from './modules/profile/router'
import { createProfileService } from './modules/profile/service'
import { createSqlProfileStore } from './modules/profile/store'
import { createConnectionHub } from './modules/realtime/hub'
import { createRealtimeRouter } from './modules/realtime/router'
import { createRecommendationDomainRecorder } from './modules/recommendation/domain-events'
import { createDbInterestRefreshQueue } from './modules/recommendation/interest-queue'
import { createTokenBucketLimiter } from './modules/recommendation/rate-limit'
import { createRecommendationRecall } from './modules/recommendation/recall/service'
import { createRecommendationRouter } from './modules/recommendation/router'
import { createRecommendationService } from './modules/recommendation/service'
import { createSqlRecommendationStore } from './modules/recommendation/store'
import { createTransactionReviewsRouter } from './modules/transaction-reviews/router'
import { createTransactionReviewService } from './modules/transaction-reviews/service'
import { createSqlTransactionReviewStore } from './modules/transaction-reviews/store'
import { createTransactionsRouter } from './modules/transactions/router'
import { createTransactionService } from './modules/transactions/service'
import { createSqlTransactionStore } from './modules/transactions/store'
import { createSqlListingMediaObjectStore } from './modules/uploads/media-objects'
import { createUploadsRouter } from './modules/uploads/router'
import { createUploadService } from './modules/uploads/service'
import { createBunS3MediaStorage } from './modules/uploads/storage'
import { createUsersRouter } from './modules/users/router'
import { createPublicUserService } from './modules/users/service'
import { createSqlPublicUserStore } from './modules/users/store'
import { createViewHistoryRouter } from './modules/view-history/router'
import { createViewHistoryService } from './modules/view-history/service'
import { createSqlViewHistoryStore } from './modules/view-history/store'
import { createVisualParser } from './modules/visual-search/parse'
import { createVisualSearchRateLimiter } from './modules/visual-search/rate-limit'
import { createVisualSearchRouter } from './modules/visual-search/router'
import { createVisualSearchService } from './modules/visual-search/service'
import { createVisualSearchStore } from './modules/visual-search/store'
import { createVisualSearchSubjectResolver } from './modules/visual-search/subject'
import { createDbWishMatchQueue } from './modules/wishes/match-queue'
import { createWishesRouterFromDb } from './modules/wishes/router'
import { createDefaultLatencyRecorder } from './observability/latency'
import { createRecommendationProcessMetrics } from './observability/recommendation-metrics'
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
  lookupNetwork: { peerIp: (request: Request) => string | null; trustedProxyIp: string | null } = {
    peerIp: () => null,
    trustedProxyIp: null,
  },
  /**
   * 内容安全审核配置（#228 的 transport + 腾讯凭证，#286 起真正被消费）：index.ts 用
   * `loadContentModerationEnv()` 做启动期校验后传入。默认值是**不发布**的 `local` transport ——
   * 本地 provider 给不出内容摘要、只能给 `REVIEW`，图片会固化但商品进人工队列，绝不会被当成
   * 审核通过（生产由 index.ts 显式传入；local 在生产直接启动失败，见 `@fish/shared/env`）。
   */
  moderationEnv: ContentModerationEnv = { transport: 'local' },
  /**
   * 视觉向量化配置（#324 M3）。`index.ts` 用 `loadVisualEmbeddingEnv()` 做启动期校验后传入；
   * 默认 `stub` 只服务测试与本机，**生产不可能静默降级**——`loadVisualEmbeddingEnv()` 在
   * `NODE_ENV=production` 遇到 stub 会直接抛错（与 worker 的 `EMBEDDING_TRANSPORT` 同一取舍）。
   */
  visualEmbeddingEnv: VisualEmbeddingEnv = { transport: 'stub' },
  /**
   * OCR/VLM 语义解析（#324 M5）。默认 `off` = 只走图片向量与结构化信号，不产生第二次上游调用、
   * 也不把查询图再发一次；开启后文本路才参与召回（见 `visual-search/parse.ts` 的 fail-open）。
   */
  visualParseEnv: VisualParseEnv = { transport: 'off' },
) {
  const db = createDb(env.DATABASE_URL)
  const app = new Hono()

  app.use('*', cors({ origin: env.WEB_ORIGIN, exposeHeaders: [RECOMMENDATION_HEADERS.sessionId] }))

  // 品牌静态图（#325）：`apps/web` 移除后站点静态根不存在了，邮件 logo / README 头图改由
  // API 托管，URL 形如 `${WEB_ORIGIN}/api/brand/logo.png`（生产 Caddy 的 `/api/*` 剥前缀）。
  app.route('/', createBrandAssetsRouter())

  // The auth module also has authenticated write endpoints. Construct the shared guard
  // before mounting auth, so those writes follow the same restriction rules as domains.
  const governanceStore = createSqlGovernanceStore(db)
  const guardDb = createDb(env.DATABASE_URL, { max: 4 })
  const restrictionGuard = createRestrictionGuard({ store: createSqlGovernanceStore(guardDb) })

  // 在线态登记表（#359 第五点）：进程内单例，口径是「最近一次已认证活动 + TTL」。
  // 它必须**早于 auth 创建**——auth 的 requireAuth / resolveViewerId 是全部已认证请求的
  // 入口，在那里记心跳（见 middleware.ts 的 onAuthenticated）。
  //
  // `broadcastPresence` 是**函数声明**（会被提升）：它引用的 `conversationStore` 与 `hub`
  // 在下面的聊天模块里才创建。函数体只在请求到来时执行，那时两者早已初始化 ——
  // 这不是"用到未初始化的 const"，而是"晚于声明的调用点"。
  async function broadcastPresence(userId: string, presence: UserPresence): Promise<void> {
    try {
      const counterparts = await conversationStore.listCounterpartUserIds(userId)
      if (counterparts.length === 0) return
      hub.pushToUsers(counterparts, {
        type: 'presence.changed',
        userId: encodePublicId(PUBLIC_ID_PREFIX.user, userId),
        presence,
      })
    } catch (error) {
      // 广播失败不得影响用户这次请求（与 message.new 的推送同一取舍）：只留痕。
      console.warn('[api] presence.changed 广播失败', describeError(error))
    }
  }

  const presence = createPresenceRegistry({
    onChange: (userId, snapshot) => {
      // 只在「离线 → 在线」时回调（见 presence.ts）；这里 fire-and-forget，
      // 查询广播目标与推送都在下一个微任务里完成，不阻塞这次请求。
      void broadcastPresence(userId, snapshot)
    },
  })

  // 认证模块的装配在 modules/auth 内，这里只负责接线（#3；#68 改为邮箱验证码子域）。
  // secureCookie 由 WEB_ORIGIN 的 scheme 推导：本地 http 加 Secure 会让 cookie 直接失效。
  //
  // #68：注册一律 UNVERIFIED；认证走校园邮箱验证码（Provider 见 verification-provider.ts，
  // dev 实现写 .dev/mail-outbox.jsonl，不进日志）。接入真实 SMTP / CAS 时只换 Provider 实现。
  // 邮件里的图片必须绝对地址；#325 起 logo 由 API 自己托管（apps/api/public/brand/logo.png），
  // 生产 Caddy 的 `/api/*` 会剥前缀再转发，所以对外地址固定带 `/api`。
  // transport 由 MAIL_TRANSPORT 显式选择（无默认值，缺配置启动失败，不静默降级）。
  const brandLogoUrl = `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/brand/logo.png`
  const auth = createAuthModule({
    db,
    verification: createVerificationService({
      db,
      provider:
        mailEnv.transport === 'resend'
          ? createResendEmailVerificationProvider(
              { apiKey: mailEnv.resendApiKey, from: mailEnv.resendFrom },
              { logoUrl: brandLogoUrl },
            )
          : createDevEmailVerificationProvider(undefined, {
              logoUrl: brandLogoUrl,
            }),
    }),
    secureCookie: env.WEB_ORIGIN.startsWith('https://'),
    wechat: wechatEnv,
    guard: restrictionGuard,
    // 在线态心跳（#359 第五点）：已认证 HTTP 请求 / 可选身份读路径都算一次活动。
    onAuthenticated: (userId) => presence.touch(userId),
    clientIp: (request) =>
      trustedClientIp(request, lookupNetwork.peerIp(request), lookupNetwork.trustedProxyIp),
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
    legacyUrlBase: `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/uploads/legacy`,
    legacyUrlSecret: meetupEnv.MEETUP_TOKEN_SECRET,
    // #286 复审 blocker 2：审核中的图片固化在私有的 `listing-review-media/`，不在匿名白名单内。
    // 三端全部用 `<img>` / Taro `<Image>` 直出（小程序的原生图片加载不带 cookie），所以私有键不能
    // 指望「带鉴权代理」，只能走短期签名 URL —— 签名本身就承载授权，因此路由仍然匿名可访问。
    reviewUrlBase: `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/uploads/media`,
    reviewUrlSecret: meetupEnv.MEETUP_TOKEN_SECRET,
  })

  // #286：图片确认记录表。uploads 侧写入（审核结论 + 固化后的 final 键），listings 侧读取
  // （只允许引用已确认的 final 键），两侧共用同一个实例，读写的语义因此不可能漂移。
  const mediaObjects = createSqlListingMediaObjectStore(db)

  // Guard transactions use a separate bounded pool, preserving business-store connections;
  // both pools coordinate through the same Postgres advisory key.
  const governanceService = createGovernanceService({ db, store: governanceStore })
  const projectSystemContent = createSystemContentProjector(db)

  // #6：`GET /listings*` 匿名可用，写接口在 router 内逐路由挂 requireAuth（读路径不能整体 401）。
  const listingService = createListingService({
    store: createSqlListingStore(db),
    storage,
    mediaObjects,
    // #228：Listing 文本审核走同一份 moderation env（`CONTENT_MODERATION_TRANSPORT=local|tencent`，
    // production 缺腾讯配置时由 env 层 fail-fast）。`loadImage` 不会被调用——图片审核在 uploads 的
    // confirm 里（#286），listings 只用 `moderateText`。
    moderationProvider: createContentModerationProvider(moderationEnv, {
      loadImage: () => Promise.reject(new Error('listings 不使用图片审核')),
    }),
  })
  app.route(
    '/listings',
    createListingsRouter({
      service: listingService,
      numberLookup: createListingNumberLookup(db, listingService, meetupEnv.MEETUP_TOKEN_SECRET),
      requireAuth: auth.requireAuth,
      resolveViewerId: auth.resolveViewerId,
      resolveClientIp: (c) =>
        trustedClientIp(c.req.raw, lookupNetwork.peerIp(c.req.raw), lookupNetwork.trustedProxyIp),
      guard: restrictionGuard,
    }),
  )
  // #323 R1：行为埋点与推荐上下文。推荐 Feed 与事件写入都**匿名可用**（未登录访客也要能看首页，
  // 登录前的行为更要能采集），所以整条不挂 requireAuth —— 与 listings 的「读公开、写必须登录」不同。
  //
  // 推荐 Feed 复用 listingService 的读路径（R1 不重写列表查询），只把结果包上推荐上下文；
  // 真实多路召回 / ranker / re-rank 归 R3/R4。
  //
  // 实例只建一次：服务端确证行为的埋点（评论 / 会话 / 交易）复用同一个 recorder，
  // 各业务模块只依赖那个窄接口，不需要知道推荐模块的 store 与召回。
  //
  // 语义召回按 `listing_visual_embeddings.model` 过滤，模型名必须与 worker 回填
  // （`VISUAL_EMBED_LISTING` handler 写的 `provider.model`）**完全一致**：两个进程读同一份
  // `VISUAL_EMBEDDING_*`，而 `stub` 传输写的是包里的确定性模型名（不是空值）。取错名字不会报错，
  // 只会让语义通道永远过滤不到向量（表现成"召回总是空"），所以这里从同一个常量推导。
  // 进程内延迟采样（#323 R6 §6.4）：**一个进程一个实例**，推荐 router 写、admin service 读。
  //
  // 刻意放在 `observability/` 而不是推荐模块里：admin 要读这些数字，但让 admin 去 import
  // 推荐模块的内部对象会把管理端与推荐域耦死。依赖方向保持"两个 domain 都依赖 observability"。
  // 采样只存在内存里，重启归零——这是 D5（零 schema 变更）的代价，契约里用 `processStartedAt`
  // 明示"自本进程启动以来"。
  const latencyRecorder = createDefaultLatencyRecorder()
  // 进程内计数（#323 R6 §6.3）：与 latency 同一取舍（一个进程一个实例、写方是推荐模块、读方是 admin）。
  // 传**读取函数**给 admin，见 `admin/module.ts` 的注释。
  const recommendationProcessMetrics = createRecommendationProcessMetrics()
  // 限流阈值（#323 R6 §8.1）：默认值来自契约，env 只做覆盖（未配置 = null ⇒ 用默认值）。
  // 两份桶分开建（埋点更严、Feed 更宽），桶表上限共用一份：它防的是"内存被主体数撑爆"，
  // 与"每个主体多少额度"无关。
  const rateLimitEnv = loadRecommendationRateLimitEnv()
  const recommendationRateLimit = {
    events: createTokenBucketLimiter({
      capacity: rateLimitEnv.eventCapacity ?? RECOMMENDATION_EVENT_RATE_LIMIT.capacity,
      refillPerSecond:
        rateLimitEnv.eventRefillPerSecond ?? RECOMMENDATION_EVENT_RATE_LIMIT.refillPerSecond,
      maxSubjects: RECOMMENDATION_RATE_LIMIT_MAX_SUBJECTS,
    }),
    feed: createTokenBucketLimiter({
      capacity: rateLimitEnv.feedCapacity ?? RECOMMENDATION_FEED_RATE_LIMIT.capacity,
      refillPerSecond:
        rateLimitEnv.feedRefillPerSecond ?? RECOMMENDATION_FEED_RATE_LIMIT.refillPerSecond,
      maxSubjects: RECOMMENDATION_RATE_LIMIT_MAX_SUBJECTS,
    }),
  }
  const recallEmbeddingModel =
    visualEmbeddingEnv.transport === 'live' ? visualEmbeddingEnv.model : STUB_VISUAL_EMBEDDING_MODEL
  const recommendationService = createRecommendationService({
    store: createSqlRecommendationStore(db),
    listings: listingService,
    // 多路召回（R3）：六路各自降级、整体不抛，因此 Feed 不需要为它准备 500 分支。
    recall: createRecommendationRecall({
      db,
      embeddingModel: recallEmbeddingModel,
      latency: latencyRecorder,
    }),
    // 长期画像重算的出队口：行为一落库就投 `REFRESH_USER_INTEREST`，由 worker 全量重算
    // （画像只给登录用户，匿名行为不投 job）。
    interest: createDbInterestRefreshQueue(db),
    // 进程内计数（#323 R6 §6.3）：写失败 / 拒收原因分布，由 admin 端点读出。
    metrics: recommendationProcessMetrics,
  })
  const recommendationRecorder = createRecommendationDomainRecorder(recommendationService)
  app.route(
    '/recommendations',
    createRecommendationRouter({
      service: recommendationService,
      resolveViewerId: auth.resolveViewerId,
      latency: latencyRecorder,
      rateLimit: recommendationRateLimit,
      processMetrics: recommendationProcessMetrics,
      // 匿名限流键要带 IP（§2.3 fail-closed 共享桶），取值与 listings / 拍照搜图同一实现：
      // 未配可信代理时 `trustedClientIp` 只要看到任何转发头就返回 null ⇒ 落进共享桶而不是伪造出的 IP。
      resolveClientIp: (c) =>
        trustedClientIp(c.req.raw, lookupNetwork.peerIp(c.req.raw), lookupNetwork.trustedProxyIp),
    }),
  )
  // 上传域实例只建一次：#86 B 的头像写入复用同一个 `confirm`（归属前缀 + 对象已上传 +
  // 格式/大小 + #286 的图片审核与固化），发布商品与改头像的失败码与文案因此不可能漂移。
  //
  // `createModeration` 是工厂而非实例：每次 confirm 现绑一个 provider，注入的 `loadImage`
  // 直接回放本次已经读到的字节，对象存储只读一次（provider 内部重试只重放 IMS 调用）。
  const uploadService = createUploadService({
    storage,
    mediaObjects,
    createModeration: (loadImage) => createContentModerationProvider(moderationEnv, { loadImage }),
  })
  app.route(
    '/uploads',
    createUploadsRouter({
      storage,
      legacyUrlSecret: meetupEnv.MEETUP_TOKEN_SECRET,
      reviewUrlSecret: meetupEnv.MEETUP_TOKEN_SECRET,
      requireAuth: auth.requireAuth,
      service: uploadService,
      guard: restrictionGuard,
    }),
  )

  // 拍照识图搜索（#324 M4）：两个端点都**匿名可用**（Q6=B），所以整条不挂 requireAuth，
  // 只做可选身份解析（登录按 userId 计配额，匿名按会话 + 出口 IP 两条都算）。
  //
  // 视觉向量化 provider 在这里装配一次：查询图要现场向量化，而列表侧（worker 的
  // VISUAL_EMBED_LISTING 回填）用的是**同一个** `VISUAL_EMBEDDING_MODEL`——两边的向量只有
  // 同模型同维度才能互相比较，所以模型名必须来自同一处配置而不是各自写死。
  //
  // 存储实例**另建一个**（复用同一个 S3 客户端）：查询图是私有临时对象，presign 有效期按
  // `VISUAL_QUERY_PRESIGN_EXPIRES_SECONDS`（300s）缩短，比商品图 staging 的 600s 更短；
  // 而 `expiresInSeconds` 是实例级配置，改共享实例会连带改掉商品图上传的窗口。
  const visualStorage = createBunS3MediaStorage({
    client: new Bun.S3Client({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
    }),
    publicUrlBase: env.S3_PUBLIC_URL,
    expiresInSeconds: VISUAL_QUERY_PRESIGN_EXPIRES_SECONDS,
  })
  const visualEmbeddingProvider = createVisualEmbeddingProvider(visualEmbeddingEnv)
  const visualSearchService = createVisualSearchService({
    store: createVisualSearchStore(db),
    storage: visualStorage,
    provider: visualEmbeddingProvider,
    parser: createVisualParser(visualParseEnv),
    rateLimiter: createVisualSearchRateLimiter(db),
  })
  app.route(
    '/visual-search',
    createVisualSearchRouter({
      service: visualSearchService,
      // 复用面交码那把 API-only 密钥做匿名主体的 HMAC：领域分隔（session / ip）在 scope 前缀里做，
      // 不为一个派生值再引入一份新配置。
      subjects: createVisualSearchSubjectResolver(meetupEnv.MEETUP_TOKEN_SECRET),
      resolveViewerId: auth.resolveViewerId,
      resolveClientIp: (c) =>
        trustedClientIp(c.req.raw, lookupNetwork.peerIp(c.req.raw), lookupNetwork.trustedProxyIp),
    }),
  )

  // 交易评价 service（#195 PR2）：一个实例两处用 —— 评价边 router 直接挂，
  // comments 的 `/me/comments?kind=review|all` 借道它读评价时间线。
  const transactionReviewService = createTransactionReviewService({
    store: createSqlTransactionReviewStore(db),
    storage,
  })

  // 留言 / 评论（#111、#195）：挂根路径，因为端点跨 `/listings/:id/comments`、
  // `/comments/:id/replies`、`/comments/:id`（DELETE）与 `/me/comments`（路径常量在
  // `@fish/contracts/comments/routes`）。读接口匿名可用、写与本人作用域逐路由挂 requireAuth
  // （与 listings 同一分界）；`storage` 复用同一实例 —— 本人留言列表里的商品卡片封面
  // 与 feed / 详情必须同一套拼法。`/me/comments` 的 `kind=review|all`（#195 PR2）借道
  // 评价域 service（装配在下面），comments 自己不摸评价表。
  app.route(
    '/',
    createCommentsRouter({
      service: createCommentService({
        store: createSqlCommentStore(db),
        storage,
        reviews: transactionReviewService,
      }),
      requireAuth: auth.requireAuth,
      guard: restrictionGuard,
      recorder: recommendationRecorder,
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
      service: createPublicUserService({
        store: createSqlPublicUserStore(db),
        storage,
        presence,
      }),
    }),
  )

  // 收藏关系（#190）：`GET /me/favorites` 与 `GET|POST|DELETE /listings/:listingId/favorite`。
  // 本域**没有匿名路径**（收藏是「我」与某件商品之间的关系，浏览者是谁决定看得到哪一份数据），
  // 所以两条路径整挂 requireAuth；router 内部还兜一层失败关闭（拿不到可信 userId → 401）。
  // 只读写 `favorites` / `listings` / `listing_images` 表，不调用其他 Domain API
  // （与 profile / users 同一取舍）；`storage` 复用同一实例 —— 收藏列表里的卡片封面
  // 与 feed / 详情必须同一套拼法。挂根路径，因为两个端点分属 `/me/...` 与 `/listings/...`。
  app.use('/me/favorites', auth.requireAuth)
  app.use('/listings/:listingId/favorite', auth.requireAuth)
  app.route(
    '/',
    createFavoritesRouter({
      service: createFavoriteService({ store: createSqlFavoriteStore(db), storage }),
      getUserId: (c) => c.get('userId'),
      // #323 R4 决策 6：`FAVORITE` / `UNFAVORITE` 的服务端真值来源。客户端上报会随断网重试整批丢，
      // 而这两个事件分别是权重表里最强的正信号与负反馈特征之一。
      recorder: recommendationRecorder,
    }),
  )

  // 交易评价（#195 PR2）：`GET|POST|DELETE /transactions/:transactionId/review`（(我, 交易)
  // 这条边的三个方法）与 `GET /transactions/:transactionId/reviews`（两方评价对账）。
  // 本域**没有匿名路径**（评价是交易双方的私有成交证据，非参与者 404 不泄漏存在性），
  // 两条路径整挂 requireAuth；router 内部还兜一层失败关闭。只读写
  // `transaction_reviews` / `transaction_review_images` / `transactions` 表
  // （与 profile / favorites 同一取舍）；`storage` 复用同一实例 —— 配图 URL 与其它域同拼法。
  // 挂根路径：两个 pattern 都比 transactions router 的 `/transactions/:id` 多一段，不会截胡。
  app.use('/transactions/:transactionId/review', auth.requireAuth)
  app.use('/transactions/:transactionId/reviews', auth.requireAuth)
  app.route(
    '/',
    createTransactionReviewsRouter({
      service: transactionReviewService,
      getUserId: (c) => c.get('userId'),
    }),
  )

  // 关注关系（#188）：`GET /me/following` 与 `GET|POST|DELETE /users/:userId/follow`。
  // 本域**没有匿名路径**（关注关系是「我」与某个人的有向边），所以两条路径整挂 requireAuth；
  // router 内部还兜一层失败关闭（拿不到可信 userId → 401）。只读写 `follows` / `users` 表，
  // 不调用其他 Domain API（与 profile / users 同一取舍）。
  app.use('/me/following', auth.requireAuth)
  app.use('/users/:userId/follow', auth.requireAuth)
  app.route(
    '/',
    createFollowsRouter({
      service: createFollowService({ store: createSqlFollowStore(db) }),
      getUserId: (c) => c.get('userId'),
    }),
  )

  // 拉黑关系（#466）：`GET /me/blocks` 与 `GET|POST|DELETE /users/:userId/block`。本域
  // 没有匿名路径（拉黑是「我」与某个人的有向边），两条路径整挂 requireAuth；router 内部
  // 兜一层失败关闭。**生效不在这里**：chat 域三个 service（会话创建 / 消息 / 媒体）持有
  // 同一个 blockStore 的 `existsBlockBetween` 谓词做双向守卫，中性码见 chat 契约。
  const blockStore = createSqlBlockStore(db)
  app.use(BLOCK_ROUTES.myBlocks, auth.requireAuth)
  app.use('/users/:userId/block', auth.requireAuth)
  app.route(
    '/',
    createBlocksRouter({
      service: createBlockService({ store: blockStore }),
      getUserId: (c) => c.get('userId'),
    }),
  )

  // 浏览记录（#415 M1）：`GET|DELETE /me/view-history`。本域没有匿名路径（记录是「我」的
  // 资产），整挂 requireAuth，router 内部再兜一层失败关闭。只读写 `listing_view_history` /
  // `listings` / `listing_images` / `users` 表；写入不在这里 —— 由 `POST /recommendations/events`
  // 的 DETAIL_VIEW 在事件落库的同一事务里 upsert（view-history/ingest.ts），端上零新增调用。
  // storage 复用同一实例：卡片封面与 feed / 详情必须同一套拼法。
  app.use(VIEW_HISTORY_ROUTES.myViewHistory, auth.requireAuth)
  app.route(
    '/',
    createViewHistoryRouter({
      service: createViewHistoryService({ store: createSqlViewHistoryStore(db), storage }),
      getUserId: (c) => c.get('userId'),
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
        blocks: blockStore,
        // 对方的在线态由进程内登记表直接读（#359 第五点），与公开资料的 presence 同源。
        presence,
        projectContent: projectSystemContent,
        // 读位推进后推给会话双方的全部在线连接（#149）：与 message.new 同一通道，
        // 客户端按 readerId 区分「自己读的」与「对方读的」。
        onRead: (participants, event) => {
          hub.pushToUsers([participants.buyerId, participants.sellerId], {
            type: 'conversation.read',
            conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, event.conversationId),
            readerId: encodePublicId(PUBLIC_ID_PREFIX.user, event.readerId),
            readAt: event.readAt,
          })
        },
      }),
      requireAuth: auth.requireAuth,
      guard: restrictionGuard,
      recorder: recommendationRecorder,
    }),
  )
  app.route(
    '/',
    createChatWatchersRouter({
      service: createChatWatchersService(conversationStore),
      requireAuth: auth.requireAuth,
    }),
  )
  app.route(
    '/conversations',
    createMediaRouter({
      service: createMediaMessageService({
        store: createSqlMediaMessageStore(db),
        storage,
        blocks: blockStore,
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
        blocks: blockStore,
        // LISTING（#359）卡片封面的 URL 拼装；与会话头商品卡共用同一个 storage 实例。
        storage,
        projectContent: projectSystemContent,
        onMessageCreated: (participants, message) => {
          hub.pushToUsers([participants.buyerId, participants.sellerId], {
            type: 'message.new',
            conversationId: message.conversationId,
            message,
          })
        },
        // #359 3c 撤回：落库成功后推给会话双方（同一人多连接也要同步）。
        onMessageRecalled: (participants, event) => {
          hub.pushToUsers([participants.buyerId, participants.sellerId], {
            type: 'message.recalled',
            conversationId: event.conversationId,
            messageId: event.messageId,
            recalledAt: event.recalledAt,
            recalledBy: event.recalledBy,
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
      // 长连接的心跳续在线态（#359 第五点）：安静挂着的 WebSocket 没有 HTTP 请求，
      // 不靠 20s 一次的 ping 续命的话，TTL 一过就会被判成离线。
      onHeartbeat: (userId) => presence.touch(userId),
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
            conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, message.conversation_id),
            message: toMessageDto(message),
          })
        },
        // 交易进展通知（任务一 #89）：fire-and-forget，失败不影响交易响应。
        // payload 存裸 UUID（与 worker 的 MATCH 写入同一形态），读侧转公开 TypeID。
        notify: async (input) => {
          try {
            await writeNotification(db, {
              userId: input.userId,
              type: 'TX',
              payload: {
                event: input.event,
                conversationId: input.conversationId,
                listingId: input.listingId,
                ...(input.transactionId ? { transactionId: input.transactionId } : {}),
              },
            })
          } catch (error) {
            console.warn('[api] 交易通知写入失败（不影响交易）', error)
          }
        },
      }),
      requireAuth: auth.requireAuth,
      guard: restrictionGuard,
      recorder: recommendationRecorder,
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
    guard: restrictionGuard,
    // `GET /admin/recommendations/metrics` 的 latency 块读同一份采样（PR-1）；
    // 进程内的事件写入计数（eventWriteFailureRate / 拒收原因分布 / 429 次数）读同一份计数器（PR-2），
    // 传读取函数以保证读到的是**当前**累计值。
    latency: latencyRecorder,
    recommendationProcessMetrics: () => recommendationProcessMetrics.snapshot(),
  })
  app.route('/admin', admin.router)

  // 举报入口只允许登录用户；与管理端共用同一个持久化 service。
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
