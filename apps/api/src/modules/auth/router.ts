import { PhoneBindRequestSchema, PhoneBindResponseSchema } from '@fish/contracts/auth/phone'
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
import { createAuthService } from './service'
import { createSessionCookie, createSessions } from './session'
import type { VerificationService } from './verification-service'
import { VerificationError } from './verification-store'
import { createStubWechatIdentityProvider, createWechatAuthService } from './wechat-service'

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
}) {
  const cookie = createSessionCookie(options.secureCookie)
  const service = createAuthService({ db: options.db, sessions: createSessions(options.db) })
  const requireAuth = createRequireAuth({ cookie, service })
  // #86 A：当前仓库没有小程序 AppSecret，真实 Provider（jscode2session）接入前
  // 只有 stub 实现——「同一 code 同一 openid」的幂等语义与真实接口一致；
  // 拿到真实凭证时只替换 provider，登录 / 建号 / 会话语义不变。
  const wechat = createWechatAuthService({
    db: options.db,
    sessions: createSessions(options.db),
    provider: createStubWechatIdentityProvider(),
  })

  const router = new Hono<{ Variables: AuthVariables }>()

  // ---- 微信登录（#86 A）：Miniapp 主身份入口 ----
  router.post('/wechat/session', async (c) => {
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
    const parsed = PhoneBindRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法'), 422)

    try {
      // stub：phone code 即明文手机号（getPhoneNumber 真实接入需要企业主体 + AppSecret，
      // 到位后只替换这段解析，绑定语义不变）。11 位手机号在服务端再收口一次。
      const phone = parsed.data.code.trim()
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
