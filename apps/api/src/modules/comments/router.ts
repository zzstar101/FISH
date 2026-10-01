import { COMMENT_ROUTES } from '@fish/contracts/comments/routes'
import {
  CommentCreateInputSchema,
  CommentIdSchema,
  CommentListQuerySchema,
  MyCommentsQuerySchema,
} from '@fish/contracts/comments/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { ListingIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import type { RecommendationDomainRecorder } from '../recommendation/domain-events'
import { type CommentService, CommentServiceError } from './service'

export type CommentsRouterOptions = {
  service: CommentService
  /**
   * #323 §M0：留言成功是服务端确证的行为，由服务端补一条 COMMENT 事件（客户端不报）。
   * 可选依赖：不传就没有埋点，既有测试/其它装配不必知道推荐模块存在。
   */
  recorder?: RecommendationDomainRecorder
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
/** 「我发过的留言」（#195）与删除某条留言：都要求登录（本人作用域）。 */
const MY_COMMENTS_PATH = COMMENT_ROUTES.myComments
const COMMENT_PATH = COMMENT_ROUTES.comment(':commentId')

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
      const comment = await service.createComment(c.get('userId'), listingId, parsed.data)
      // 埋点是旁路：`record` 内部已吞掉全部异常，不会把已成功的留言变成 500。
      if (options.recorder) {
        await options.recorder.record(c, {
          viewerId: c.get('userId'),
          listingId,
          eventType: 'COMMENT',
        })
      }
      return c.json(comment, 201)
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
      const reply = await service.createReply(c.get('userId'), commentId, parsed.data)
      // 回复与顶层留言是同一张表、同一 listing 上的新行（`createReply` 自己 insert，
      // 不经过 `createComment`），所以这里必须单独补一次埋点 —— ingest 又拒收客户端
      // 上报的 COMMENT，漏掉这条路等于把"回复"这类强正反馈整条丢掉。
      // DTO 的 `listingId` 是公开 id（`CommentDtoSchema`），record 要的是解码后的 DB uuid。
      if (options.recorder) {
        await options.recorder.record(c, {
          viewerId: c.get('userId'),
          listingId: decodePublicId(PUBLIC_ID_PREFIX.listing, reply.listingId),
          eventType: 'COMMENT',
        })
      }
      return c.json(reply, 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // —— 本人作用域（#195）：读我发过的留言、删自己的留言。两条都要求登录 ——
  // 作者由可信 context 决定，不接受 `authorId` 查询参数（放开它等于把「谁在哪儿说了什么」
  // 变成可枚举的公开数据）；`MyCommentsQuerySchema` 是 `strictObject`，多传即 422。
  router.get(MY_COMMENTS_PATH, options.requireAuth, async (c) => {
    const parsed = MyCommentsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.listMine(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 删除是写操作，过与发留言同一道 `guard.write`（受限账号不能靠删除绕过限制）。
  router.delete(COMMENT_PATH, options.requireAuth, options.guard.write, async (c) => {
    const commentId = requireResourceId(c, 'commentId')
    // 非法 id 直接 404（与既有留言路由同口径）：避免非 uuid 绑到 uuid 列后抛驱动错误变 500。
    // 注意 service 里「不存在」走的是 200 `{deleted: 0}`（幂等），404 只表示「存在但不是你的」。
    if (!commentId) return c.json(errorBody('COMMENT_NOT_FOUND', '留言不存在'), 404)

    try {
      return c.json(await service.deleteMine(c.get('userId'), commentId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}
