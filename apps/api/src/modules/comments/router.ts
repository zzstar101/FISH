import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import {
  CommentCreateInputSchema,
  CommentIdSchema,
  CommentListQuerySchema,
} from '@fish/contracts/comments/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { ListingIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { type CommentService, CommentServiceError } from './service'

export type CommentsRouterOptions = {
  service: CommentService
  /**
   * 写接口的登录守卫，由 `auth` 模块提供。**读接口匿名可用**（与 listings 的 §0.2
   * 同一分界），所以不能用 `router.use('*', requireAuth)`。
   *
   * `isSeller` 由服务端拿 listing.sellerId 判定，读路径不需要 viewer，因此 GET 完全不碰身份。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** #73 治理守卫：写留言前检查封禁（留言只有 `write` 一种作用域）。 */
  guard: RestrictionGuard
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

/** 路径参数必须是合法 UUID；否则直接 404，避免非 uuid 绑到 uuid 列后抛驱动错误变 500。 */
function requireResourceId(c: Context, name: 'listingId' | 'commentId'): string | null {
  const raw = c.req.param(name) ?? ''
  const prefix = name === 'listingId' ? PUBLIC_ID_PREFIX.listing : PUBLIC_ID_PREFIX.comment
  const valid =
    name === 'listingId'
      ? ListingIdSchema.safeParse(raw).success
      : CommentIdSchema.safeParse(raw).success
  return valid ? decodePublicId(prefix, raw) : null
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof CommentServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

/**
 * 路由 pattern 也从契约常量派生：把参数名当占位 id 传进去，
 * 这样 `/listings/:listingId/comments` 这份字面量不存在第二处（禁止硬编码）。
 */
const LISTING_COMMENTS_PATH = COMMENT_ROUTES.ofListing(':listingId')
const COMMENT_REPLIES_PATH = COMMENT_ROUTES.repliesOf(':commentId')

/**
 * 留言 router。
 *
 * 挂载在根路径（`app.route('/', …)`），因为三个端点跨两个资源集合：
 * `GET|POST /listings/:listingId/comments` 与 `POST /comments/:commentId/replies`。
 * 路径常量取自契约的 `COMMENT_ROUTES`，不在这里硬编码。
 */
export function createCommentsRouter(options: CommentsRouterOptions) {
  const { service } = options
  const router = new Hono<{ Variables: AuthVariables }>()

  // —— 读接口：匿名可用（与 listings 的读公开同一口径）——
  router.get(LISTING_COMMENTS_PATH, async (c) => {
    const listingId = requireResourceId(c, 'listingId')
    if (!listingId) return c.json(errorBody('LISTING_NOT_FOUND', '商品不存在'), 404)

    const parsed = CommentListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.listComments(listingId, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // —— 写接口：全部要求登录 ——
  router.post(LISTING_COMMENTS_PATH, options.requireAuth, options.guard.write, async (c) => {
    const listingId = requireResourceId(c, 'listingId')
    if (!listingId) return c.json(errorBody('LISTING_NOT_FOUND', '商品不存在'), 404)

    const parsed = CommentCreateInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.createComment(c.get('userId'), listingId, parsed.data), 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post(COMMENT_REPLIES_PATH, options.requireAuth, options.guard.write, async (c) => {
    const commentId = requireResourceId(c, 'commentId')
    if (!commentId) return c.json(errorBody('COMMENT_NOT_FOUND', '留言不存在'), 404)

    const parsed = CommentCreateInputSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.createReply(c.get('userId'), commentId, parsed.data), 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}
