import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { USER_ROUTES } from '@fish/contracts/users/routes'
import { PublicUserIdSchema, PublicUserListingsQuerySchema } from '@fish/contracts/users/schema'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type PublicUserService, PublicUserServiceError } from './service'

export type UsersRouterOptions = {
  service: PublicUserService
}

/**
 * 路径参数必须是合法 UUID。
 *
 * 不校验的话，非 UUID 会被绑到 `users.id`（uuid 列）上，PostgreSQL 直接报
 * `invalid input syntax for type uuid` → 500；而本域的契约是"不存在"→ 404。
 * 这条路径**任何匿名请求都能稳定触发**，所以必须显式校验，不能靠 SQL 兜底
 * （与 `listings/router.ts` 的 `requireListingId` 同一取舍）。
 */
function requireUserId(c: Context): string | null {
  const parsed = PublicUserIdSchema.safeParse(c.req.param('userId'))
  return parsed.success ? parsed.data : null
}

/** 与 `service.ts` 的 `userNotFound` 同码同文案：格式不合法与不存在不给可区分的响应。 */
function userNotFoundResponse(c: Context) {
  return c.json(errorBody('USER_NOT_FOUND', '用户不存在或不可见'), 404)
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof PublicUserServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

/**
 * 路由 pattern 从契约常量派生：把参数名当占位 id 传进去（禁止在别处硬编码路径）。
 */
const PUBLIC_PROFILE_PATH = USER_ROUTES.publicProfile(':userId')
const ACTIVE_LISTINGS_PATH = USER_ROUTES.activeListings(':userId')

/**
 * 公开用户主页 router（Issue #122）。
 *
 * **整条匿名可读**：他人主页对未登录访客也要能看，这与 `GET /listings` 的
 * 「读公开、写必须登录」同一条分界，所以这里不接 `requireAuth`（本域也没有写接口）。
 *
 * 挂载在**根路径**（`app.route('/', …)`），因为两个端点的资源集合都在 `/users/:userId/...`
 * 之下，路径常量取自契约的 `USER_ROUTES`。
 */
export function createUsersRouter(options: UsersRouterOptions) {
  const { service } = options
  const router = new Hono()

  router.get(PUBLIC_PROFILE_PATH, async (c) => {
    const userId = requireUserId(c)
    if (!userId) return userNotFoundResponse(c)

    try {
      return c.json(await service.getPublicProfile(userId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get(ACTIVE_LISTINGS_PATH, async (c) => {
    const userId = requireUserId(c)
    if (!userId) return userNotFoundResponse(c)

    const parsed = PublicUserListingsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.listActiveListings(userId, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type UsersRouter = ReturnType<typeof createUsersRouter>
