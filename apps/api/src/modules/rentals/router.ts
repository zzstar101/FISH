import { ListingIdSchema } from '@fish/contracts/listings/schema'
import {
  RentalCreateInputSchema,
  RentalFeedQuerySchema,
  RentalUpdateInputSchema,
} from '@fish/contracts/rentals/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { type RentalService, RentalServiceError } from './service'

/**
 * 租赁域路由（#706 RNT-02）。
 *
 * 与 `/listings` 的结构对照：读公开、写必须登录；写入口挂**同样的三道门**
 * （`requireAuth → requirePhone → guard.publish`），因为出租发布与出售发布面对的是同一批
 * 风险（未绑手机号的一次性账号、被限制发布的账号）。
 *
 * 与出售的差异只有一处：出租多一道**教育邮箱认证**要求（M0 冻结的出租资格），由 service 的
 * `assertEligible` 按 `users.auth_status` 判定 —— 它不进中间件，因为那是业务规则而不是
 * 「入口必须可枚举」的安全门（治理限制 / 手机号绑定才是）。
 */
export type RentalsRouterOptions = {
  service: RentalService
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** 读接口的可选身份：匿名返回 null，用于 `isOwner` 与非公开商品的可见性。 */
  resolveViewerId: (c: Context) => Promise<string | null>
  guard: RestrictionGuard
  requirePhone: MiddlewareHandler<{ Variables: AuthVariables }>
}

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
 * 路径参数 `:id` 必须是规范 `lst_` 公开 id。
 *
 * 出租复用 `listings` 的 id 空间（同一个 `lst_` 前缀、同一条表），所以这里用同一套校验：
 * 非 UUID 会被绑到 uuid 列上让 PG 报 500，而契约要求 404。
 */
function requireListingId(c: Context): string {
  const raw = c.req.param('id') ?? ''
  if (!ListingIdSchema.safeParse(raw).success) {
    throw new RentalServiceError(404, 'RENTAL_NOT_FOUND', '出租商品不存在或不可见')
  }
  return decodePublicId(PUBLIC_ID_PREFIX.listing, raw)
}

function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof RentalServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

export function createRentalsRouter(options: RentalsRouterOptions) {
  const { service } = options
  const router = new Hono<{ Variables: AuthVariables }>()

  // —— 读接口：匿名可用 ——

  router.get('/', async (c) => {
    const parsed = RentalFeedQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)
    try {
      return c.json(await service.listFeed(parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  /**
   * 「我发布的出租」。必须挂在 `/:id` **之前**：Hono 按注册顺序匹配，
   * `/mine` 若排在 `/:id` 之后会被当成一个 id。
   */
  router.get('/mine', options.requireAuth, async (c) => {
    try {
      return c.json(await service.listMine(c.get('userId')), 200)
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

  router.post('/', options.requireAuth, options.requirePhone, options.guard.publish, async (c) => {
    const parsed = RentalCreateInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)
    try {
      return c.json(await service.createRental(c.get('userId'), parsed.data), 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.patch('/:id', options.requireAuth, options.guard.publish, async (c) => {
    const parsed = RentalUpdateInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)
    try {
      const id = requireListingId(c)
      return c.json(await service.updateRental(c.get('userId'), id, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/:id/offline', options.requireAuth, options.guard.publish, async (c) => {
    try {
      const id = requireListingId(c)
      return c.json(await service.setStatus(c.get('userId'), id, 'OFFLINE'), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/:id/online', options.requireAuth, options.guard.publish, async (c) => {
    try {
      const id = requireListingId(c)
      return c.json(await service.setStatus(c.get('userId'), id, 'ACTIVE'), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}
