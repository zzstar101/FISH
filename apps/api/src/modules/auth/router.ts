import { PhoneBindRequestSchema, PhoneBindResponseSchema } from '@fish/contracts/auth/phone'
import {
  SCAN_CONFIRM_PAGE,
  SCAN_VERIFIER_HEADER,
  ScanExchangeResponseSchema,
  ScanTicketResponseSchema,
  ScanTicketSchema,
  ScanTicketStatusResponseSchema,
  ScanVerifierSchema,
} from '@fish/contracts/auth/scan'
import { LoginRequestSchema, RegisterRequestSchema } from '@fish/contracts/auth/session'
import {
  SendCodeRequestSchema,
  SendCodeResponseSchema,
  VerifyCodeRequestSchema,
} from '@fish/contracts/auth/verification'
import {
  WechatSessionRequestSchema,
  WechatSessionResponseSchema,
} from '@fish/contracts/auth/wechat'
import { errorBody } from '@fish/contracts/system/error'
import type { Db } from '@fish/db/client'
import { type Context, type Handler, Hono } from 'hono'
import { AuthError } from './errors'
import { maskPhone } from './me'
import { type AuthVariables, createRequireAuth } from './middleware'
import { createScanTicketRateLimiter } from './scan-rate-limit'
import { createScanTicketService } from './scan-service'
import { createAuthService } from './service'
import { createSessionCookie, createSessions } from './session'
import type { VerificationService } from './verification-service'
import { VerificationError } from './verification-store'
import {
  createWechatAccessTokenService,
  createWechatMiniappCodeClient,
  type WechatMiniappCodeClient,
  WechatPlatformError,
} from './wechat-platform'
import {
  createLiveWechatIdentityProvider,
  createStubWechatIdentityProvider,
  createWechatAuthService,
  type WechatIdentityProvider,
} from './wechat-service'

/** JSON 解析失败（空体 / 非 JSON）也按参数不合法处理，而不是让 Hono 抛 500。 */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

/** 认证域异常 → 契约里冻结的错误信封；非认证域异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof AuthError) return c.json(errorBody(error.code, error.message), error.status)
  if (error instanceof VerificationError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/**
 * 认证模块的唯一装配入口：把会话存储、cookie、验证服务、service、守卫装配在一起，
 * `app.ts` 只负责挂载（`/auth/*` 与 `/me`）。#68 后不再有 Campus Provider：
 * 校园认证改为「验证码 Provider + verification service」的独立子域。
 */
export function createAuthModule(options: {
  db: Db
  verification: VerificationService
  /** 由 `WEB_ORIGIN` 的 scheme 推导，见 `session.ts`。 */
  secureCookie: boolean
  /**
   * 微信身份解析的显式配置（#86 评审 P1：stub 必须与生产隔离）。
   * `off` = 登录 / 绑定入口关闭（503 WECHAT_DISABLED）；`stub` = 只允许非生产显式开启；
   * `live` = 真实 jscode2session。**没有默认值**，调用方必须从 `loadWechatEnv()` 显式传入。
   */
  wechat: import('@fish/shared/env').WechatEnv
  /**
   * 客户端 IP 解析（#197 建票限流用）。由 `index.ts` 从 `Bun.serve` 的 `requestIP` 注入——
   * 不用 `x-forwarded-for` 之类可伪造的请求头，否则限流形同虚设。
   * 测试里可以注入固定值；拿不到时退化为同一个「未知」桶（宁可少放行，也不放开）。
   */
  clientIp?: (request: Request) => string | null
}) {
  const cookie = createSessionCookie(options.secureCookie)
  const service = createAuthService({ db: options.db, sessions: createSessions(options.db) })
  const requireAuth = createRequireAuth({ cookie, service })
  const wechatSessions = createSessions(options.db)
  // provider 只在 stub / live 下构造；off 下保持 null，两个入口在 handler 顶部显式 503。
  const wechatProvider: WechatIdentityProvider | null =
    options.wechat.transport === 'stub'
      ? createStubWechatIdentityProvider()
      : options.wechat.transport === 'live'
        ? createLiveWechatIdentityProvider({
            appid: options.wechat.appid,
            appSecret: options.wechat.appSecret,
          })
        : null
  const wechat =
    wechatProvider !== null
      ? createWechatAuthService({
          db: options.db,
          sessions: wechatSessions,
          provider: wechatProvider,
        })
      : null
  // 手机号解析与微信登录共用同一 transport（真实接入两者都依赖同一 AppSecret 凭据）。
  const phoneResolver: ((code: string) => string) | null =
    options.wechat.transport === 'stub' ? (code) => code.trim() : null

  /**
   * 微信平台侧能力（#197）：**整个进程只在这里创建一份**缓存与刷新循环。
   * 只有 `live` 才构造——`off` 显式 503、`stub` 生成不了真码（出码为 null，由端上走
   * 开发者工具），两者都不该去调上游。将来 #204 的手机号换取复用同一个 `tokens` 实例。
   */
  const wechatPlatform: { codes: WechatMiniappCodeClient } | null =
    options.wechat.transport === 'live'
      ? {
          codes: createWechatMiniappCodeClient({
            tokens: createWechatAccessTokenService({
              appid: options.wechat.appid,
              appSecret: options.wechat.appSecret,
            }),
          }),
        }
      : null
  const scanTickets = createScanTicketService({ db: options.db, sessions: wechatSessions })
  const scanTicketLimiter = createScanTicketRateLimiter()

  const router = new Hono<{ Variables: AuthVariables }>()

  // ---- 微信登录（#86 A）：Miniapp 主身份入口 ----
  router.post('/wechat/session', async (c) => {
    if (wechat === null) {
      // WECHAT_TRANSPORT=off：能力未开通，503 显式状态，不当作登录失败
      return c.json(errorBody('WECHAT_DISABLED', '微信登录暂未开通'), 503)
    }
    const parsed = WechatSessionRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法'), 422)

    try {
      const { user, token, expiresAt } = await wechat.signIn(parsed.data)
      cookie.attach(c, token, expiresAt)
      return c.json(WechatSessionResponseSchema.parse({ user }))
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // ---- 手机号绑定（#86 C）：只追加绑定，不动已有会话 ----
  router.post('/phone/bind', requireAuth, async (c) => {
    if (phoneResolver === null) {
      return c.json(errorBody('WECHAT_DISABLED', '手机号绑定暂未开通'), 503)
    }
    const parsed = PhoneBindRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法'), 422)

    try {
      // stub：phone code 即明文手机号（getPhoneNumber 真实接入需要企业主体 + AppSecret，
      // 到位后在 resolver 内调 phonenumber.getPhoneNumber，绑定语义不变）。
      // off / live 下 phoneResolver 为 null：live 的解析器接入前，绑定入口显式 503，
      // 绝不把「格式正确的 code」当成已验证的手机号（格式正确 ≠ 持有该号码）。
      const phone = phoneResolver(parsed.data.code)
      if (!/^1\d{10}$/.test(phone)) {
        return c.json(errorBody('PHONE_CODE_INVALID', '手机号授权凭证无效'), 422)
      }
      await service.bindPhone(c.get('userId'), phone)
      return c.json(
        PhoneBindResponseSchema.parse({ phoneBound: true, maskedPhone: maskPhone(phone) }),
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // ---- 扫码登录（#197）：Web 出码 → 小程序确认 → Web 凭据兑换 ----
  //
  // 四个端点一律 `Cache-Control: no-store`：状态接口是带 `X-Scan-Verifier` 的 GET、路径里
  // 只有公开 ticket，共享缓存若只按 URL 建键，会把 confirmed 连同 user 交给 verifier 不对的
  // 调用者——那正好绕过「只有持正确 verifier 才看得到细化状态」这条冻结项。
  //
  // 用**中间件**而不是在每个 handler 里设：`confirm` 的 `requireAuth` 会在进 handler 之前
  // 直接返回 401，逐 handler 的写法覆盖不到那条提前返回的分支。
  router.use('/wechat/scan/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })

  /** 票据 / verifier 的形状门禁。形状不对也走**统一 404**：不给匿名调用者任何区分信号。 */
  const invalidScanTicket = (c: Context) =>
    c.json(errorBody('SCAN_TICKET_INVALID', '登录二维码无效或已过期'), 404)

  router.post('/wechat/scan/ticket', async (c) => {
    // off = 能力未开通（与 #86 的其它入口同一语义）；stub 仍然可以建票，只是没有真码。
    if (options.wechat.transport === 'off') {
      return c.json(errorBody('WECHAT_DISABLED', '扫码登录暂未开通'), 503)
    }

    const ip = options.clientIp?.(c.req.raw) ?? null
    if (!scanTicketLimiter.take(ip ?? 'unknown')) {
      return c.json(errorBody('RATE_LIMITED', '请求过于频繁，请稍后再试'), 429)
    }

    const { ticket, verifier, expiresAt } = await scanTickets.create()

    let qrCodeDataUrl: string | null = null
    if (wechatPlatform !== null) {
      try {
        const image = await wechatPlatform.codes.unlimited({
          scene: ticket,
          page: SCAN_CONFIRM_PAGE,
          envVersion: options.wechat.transport === 'live' ? options.wechat.qrEnvVersion : 'release',
        })
        qrCodeDataUrl = `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`
      } catch (error) {
        if (error instanceof WechatPlatformError) {
          // 502：平台侧取码失败。与 503 WECHAT_DISABLED（能力未开通）分开，端上引导不同；
          // 最常见成因是官方那句「接口只能生成已发布小程序的二维码」。
          return c.json(errorBody('WECHAT_QR_UNAVAILABLE', '小程序码生成失败，请稍后再试'), 502)
        }
        throw error
      }
    }

    return c.json(
      ScanTicketResponseSchema.parse({
        ticket,
        verifier,
        qrCodeDataUrl,
        expiresAt: expiresAt.toISOString(),
      }),
    )
  })

  router.get('/wechat/scan/ticket/:ticket', async (c) => {
    const ticket = ScanTicketSchema.safeParse(c.req.param('ticket'))
    const verifier = ScanVerifierSchema.safeParse(c.req.header(SCAN_VERIFIER_HEADER))
    if (!ticket.success || !verifier.success) return invalidScanTicket(c)

    try {
      const status = await scanTickets.status({ ticket: ticket.data, verifier: verifier.data })
      return c.json(
        ScanTicketStatusResponseSchema.parse({
          status: status.status,
          expiresAt: status.expiresAt.toISOString(),
          // user 只在 confirmed 分支出现（契约用 discriminatedUnion 钉住了这点）。
          ...(status.status === 'confirmed' ? { user: status.user } : {}),
        }),
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/wechat/scan/ticket/:ticket/confirm', requireAuth, async (c) => {
    const ticket = ScanTicketSchema.safeParse(c.req.param('ticket'))
    if (!ticket.success) return invalidScanTicket(c)

    try {
      // 绑定的是**当前小程序会话**的用户；同人幂等、他人 409（service 内保证）。
      await scanTickets.confirm({ ticket: ticket.data, userId: c.get('userId') })
      // 刻意没有响应体：确认页要展示的账号来自它自己的会话，回一个恒为真的字段没有信息量。
      return c.body(null, 204)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/wechat/scan/ticket/:ticket/exchange', async (c) => {
    const ticket = ScanTicketSchema.safeParse(c.req.param('ticket'))
    const verifier = ScanVerifierSchema.safeParse(c.req.header(SCAN_VERIFIER_HEADER))
    if (!ticket.success || !verifier.success) return invalidScanTicket(c)

    try {
      const { user, token, expiresAt } = await scanTickets.exchange({
        ticket: ticket.data,
        verifier: verifier.data,
      })
      // 与 /auth/login、/auth/wechat/session 同一套 cookie 会话机制。
      cookie.attach(c, token, expiresAt)
      return c.json(ScanExchangeResponseSchema.parse({ user }))
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 注册即登录：响应体与 /me 同构，前端不需要再打一次 /auth/login
  router.post('/register', async (c) => {
    const parsed = RegisterRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法'), 422)

    try {
      const { user, token, expiresAt } = await service.register(parsed.data)
      cookie.attach(c, token, expiresAt)
      return c.json({ user })
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/login', async (c) => {
    const parsed = LoginRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法'), 422)

    try {
      const { user, token, expiresAt } = await service.login(parsed.data)
      cookie.attach(c, token, expiresAt)
      return c.json({ user })
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 登出幂等：未登录调用也是 204，登出不该有失败态
  router.post('/logout', async (c) => {
    await service.logout(cookie.read(c))
    cookie.clear(c)
    return c.body(null, 204)
  })

  // ---- 校园认证（#68）：三个端点都是本人数据，整段挂 requireAuth ----
  // 已知取舍（评审二轮指出）：`/verification/code` 对被占用邮箱返回 409
  // EMAIL_ALREADY_BOUND，等于承认「某校园邮箱是否已绑定 FISH 账号」的枚举 oracle。
  // 这是 grilling 决策 Q7c 的明确选择（调用者已登录、提前拦截省 5 分钟等待）；
  // 若未来要收紧，应在 send 阶段统一返回受理结果、冲突只在 verify 暴露。
  const verification = options.verification

  router.post('/verification/code', requireAuth, async (c) => {
    const parsed = SendCodeRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法'), 422)

    try {
      await verification.sendCode(c.get('userId'), parsed.data)
      return c.json(SendCodeResponseSchema.parse({ sent: true }))
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/verification/verify', requireAuth, async (c) => {
    const parsed = VerifyCodeRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法'), 422)

    try {
      const status = await verification.verify(c.get('userId'), parsed.data)
      return c.json(status)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/verification/status', requireAuth, async (c) =>
    c.json(await verification.status(c.get('userId'))),
  )

  const meHandler: Handler<{ Variables: AuthVariables }> = (c) => c.json({ user: c.get('me') })

  /**
   * 可选身份：匿名返回 `null`。读接口（如 `GET /listings`）用它算 `isOwner`、做 `sellerId`
   * 过滤与 OFFLINE 可见性，而不必把整个读路径变成 401。
   *
   * 与 `requireAuth` 共用同一套 cookie + session 解析，因此不存在"第二个认证入口"被绕过的问题。
   */
  async function resolveViewerId(c: Context): Promise<string | null> {
    const token = cookie.read(c)
    if (!token) return null
    const me = await service.loadMe(token)
    return me?.id ?? null
  }

  return { router, requireAuth, meHandler, resolveViewerId }
}
