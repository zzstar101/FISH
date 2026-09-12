import {
  ListingCreateInputSchema,
  ListingFeedQuerySchema,
  ListingIdSchema,
  ListingUpdateInputSchema,
} from '@fish/contracts/listings/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { type ListingService, ListingServiceError } from './service'

export type ListingsRouterOptions = {
  service: ListingService
  /**
   * 写接口的登录守卫，由 `auth` 模块提供（#6 契约 §0.2：读公开、写必须登录）。
   *
   * 不能用 `router.use('*', requireAuth)`：那会把 `GET /listings` 也变成 401，
   * 直接违背契约里"匿名可浏览与搜索"的约定。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** 读接口的**可选**身份：匿名返回 null。用于 `isOwner`、`sellerId` 过滤与 OFFLINE 可见性。 */
  resolveViewerId: (c: Context) => Promise<string | null>
}

/** JSON 解析失败（空体 / 非 JSON）按参数不合法处理，而不是让 Hono 抛 500。 */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function zodValidationFailure(
  c: Context,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
) {
  return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(issues)), 422)
}

/**
 * 路径参数 `:id` 必须是合法 UUID。
 *
 * 不校验的话，非 UUID 会被绑到 `listings.id`（uuid 列）上，PostgreSQL 直接报
 * `invalid input syntax for type uuid` → 500；而契约 §3 要求"id 不存在"是 404。
 * 这条路径**任何匿名请求都能稳定触发**，所以必须显式校验，不能靠 SQL 兜底。
 */
function requireListingId(c: Context): string {
  const parsed = ListingIdSchema.safeParse(c.req.param('id'))
  if (!parsed.success) {
    throw new ListingServiceError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')
  }
  return parsed.data
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ListingServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

export function createListingsRouter(options: ListingsRouterOptions) {
  const { service } = options
  const router = new Hono<{ Variables: AuthVariables }>()

  // —— 读接口：匿名可用（契约 §0.2 / §2.1 / §2.2）——

  router.get('/', async (c) => {
    const parsed = ListingFeedQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      const viewerId = await options.resolveViewerId(c)
      return c.json(await service.listFeed(viewerId, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/:id', async (c) => {
    try {
      const id = requireListingId(c)
      const viewerId = await options.resolveViewerId(c)
      return c.json(await service.getDetail(viewerId, id), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // —— 写接口：全部要求登录 ——

  router.post('/', options.requireAuth, async (c) => {
    const parsed = ListingCreateInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      const result = await service.createListing(c.get('userId'), parsed.data)
      // 命中 5 秒去重窗口时返回 200（同一个商品），首次创建才是 201（契约 §2.3）。
      return c.json(result.detail, result.created ? 201 : 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.patch('/:id', options.requireAuth, async (c) => {
    const parsed = ListingUpdateInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      const id = requireListingId(c)
      return c.json(await service.updateListing(c.get('userId'), id, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/:id/offline', options.requireAuth, async (c) => {
    try {
      const id = requireListingId(c)
      return c.json(await service.transition(c.get('userId'), id, 'OFFLINE'), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/:id/online', options.requireAuth, async (c) => {
    try {
      const id = requireListingId(c)
      return c.json(await service.transition(c.get('userId'), id, 'ACTIVE'), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type ListingsRouter = ReturnType<typeof createListingsRouter>
