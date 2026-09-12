import { LoginRequestSchema, RegisterRequestSchema } from '@fish/contracts/auth/session'
import { errorBody } from '@fish/contracts/system/error'
import type { Db } from '@fish/db/client'
import { type Context, type Handler, Hono } from 'hono'
import { AuthError } from './errors'
import { type AuthVariables, createRequireAuth } from './middleware'
import type { CampusVerificationProvider } from './provider'
import { createAuthService } from './service'
import { createSessionCookie, createSessions } from './session'

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
  throw error
}

/**
 * 认证模块的唯一装配入口：把会话存储、cookie、Provider、service、守卫装配在一起，
 * `app.ts` 只负责挂载（`/auth/*` 与 `/me`）。
 */
export function createAuthModule(options: {
  db: Db
  provider: CampusVerificationProvider
  /** 由 `WEB_ORIGIN` 的 scheme 推导，见 `session.ts`。 */
  secureCookie: boolean
}) {
  const cookie = createSessionCookie(options.secureCookie)
  const service = createAuthService({
    db: options.db,
    sessions: createSessions(options.db),
    provider: options.provider,
  })
  const requireAuth = createRequireAuth({ cookie, service })

  const router = new Hono<{ Variables: AuthVariables }>()

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
