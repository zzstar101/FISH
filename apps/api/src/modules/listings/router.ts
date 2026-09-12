import {
  ListingCreateInputSchema,
  ListingFeedQuerySchema,
  ListingUpdateInputSchema,
} from '@fish/contracts/listings/schema'
import { type ApiErrorDetail, errorBody } from '@fish/contracts/system/error'
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

/**
 * Zod 的 issue path → 契约 §3 的 `details[].field`（点号路径，数组下标也用点号：
 * `objectKeys.1`）。前端据此把错误定位到具体输入框。
 */
function zodDetails(issues: { path: PropertyKey[]; message: string }[]): ApiErrorDetail[] {
  return issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
}

function zodValidationFailure(c: Context, issues: { path: PropertyKey[]; message: string }[]) {
  return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法', zodDetails(issues)), 422)
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
      const viewerId = await options.resolveViewerId(c)
      return c.json(await service.getDetail(viewerId, c.req.param('id')), 200)
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
      return c.json(
        await service.updateListing(c.get('userId'), c.req.param('id'), parsed.data),
        200,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/:id/offline', options.requireAuth, async (c) => {
    try {
      return c.json(await service.transition(c.get('userId'), c.req.param('id'), 'OFFLINE'), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/:id/online', options.requireAuth, async (c) => {
    try {
      return c.json(await service.transition(c.get('userId'), c.req.param('id'), 'ACTIVE'), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type ListingsRouter = ReturnType<typeof createListingsRouter>
