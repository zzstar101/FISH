import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { TransactionIdSchema } from '@fish/contracts/system/public-id'
import { TRANSACTION_REVIEW_ROUTES } from '@fish/contracts/transaction-reviews/routes'
import {
  ReviewMediaConfirmRequestSchema,
  ReviewMediaPresignRequestSchema,
  TransactionReviewCreateInputSchema,
} from '@fish/contracts/transaction-reviews/schema'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { ReviewMediaServiceError } from './media-service'
import { type TransactionReviewService, TransactionReviewServiceError } from './service'

type ReviewVariables = { userId: string }
type ReviewContext = Context<{ Variables: ReviewVariables }>

export type TransactionReviewUserIdResolver = (context: ReviewContext) => string | undefined

export type TransactionReviewsRouterOptions = {
  service: TransactionReviewService
  /**
   * 必须从认证 middleware 写入的**服务端可信 context** 读取当前用户 id（favorites 同一约定）。
   * `app.ts` 已对两条路径整挂 `auth.requireAuth`；这里的兜底保证漏挂守卫时**失败关闭**（401），
   * 而不是把匿名请求当成本人。
   */
  getUserId: TransactionReviewUserIdResolver
  /**
   * #475 配图上传链的治理守卫（与其它写入口一致：被封禁账号 403 `USER_RESTRICTED`）。
   * **必填**——漏接等于上传链绕过治理，在类型层要求装配方显式提供。
   */
  guard: { write: MiddlewareHandler }
}

/**
 * 路径参数必须是规范的交易 Public ID；非法输入与不存在同码 404
 * （`TRANSACTION_NOT_FOUND`）：不给「格式错」与「不存在」留可区分的响应，
 * 否则这条登录可达的路径就成了一份交易 id 空间探针（favorites / listings 同一取舍）。
 */
function requireTransactionId(c: ReviewContext): string | null {
  const parsed = TransactionIdSchema.safeParse(c.req.param('transactionId'))
  return parsed.success ? decodePublicId(PUBLIC_ID_PREFIX.transaction, parsed.data) : null
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: ReviewContext, error: unknown): Response {
  if (error instanceof ReviewMediaServiceError) {
    // 429：与 recommendation 同款——`Retry-After` 头 + 信封里的 retryAfterSeconds。
    if (error.retryAfterSeconds !== undefined) {
      c.header('Retry-After', String(error.retryAfterSeconds))
    }
    return c.json(
      errorBody(error.code, error.message, error.details, error.retryAfterSeconds),
      error.status,
    )
  }
  if (error instanceof TransactionReviewServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

const transactionNotFoundResponse = (c: ReviewContext) =>
  c.json(errorBody('TRANSACTION_NOT_FOUND', '交易不存在'), 404)

/** 路由 pattern 从契约常量派生（把参数名当占位 id 传进去，禁止在别处硬编码路径）。 */
const REVIEW_EDGE_PATH = TRANSACTION_REVIEW_ROUTES.reviewEdge(':transactionId')
const REVIEWS_OF_PATH = TRANSACTION_REVIEW_ROUTES.ofTransaction(':transactionId')
const MEDIA_PRESIGN_PATH = TRANSACTION_REVIEW_ROUTES.mediaPresign(':transactionId')
const MEDIA_CONFIRM_PATH = TRANSACTION_REVIEW_ROUTES.mediaConfirm(':transactionId')

/**
 * 交易评价 router（#195 PR2）。挂载在根路径 `/`，两条路径都在 `/transactions/:transactionId`
 * 之下但比 transactions router 的路径多一段，不会互相截胡。
 *
 * **本域没有匿名路径**：评价是交易双方的私有成交证据，浏览者是谁决定了看得到哪一份数据
 * （`app.ts` 对两条路径整挂 `auth.requireAuth`）。
 */
export function createTransactionReviewsRouter({
  service,
  getUserId,
  guard,
}: TransactionReviewsRouterOptions) {
  const router = new Hono<{ Variables: ReviewVariables }>()

  const requireUserId = (c: ReviewContext): string | null => {
    const userId = getUserId(c)
    if (!userId) {
      c.json(errorBody('UNAUTHENTICATED', '未登录'), 401)
      return null
    }
    return userId
  }

  // —— 「(我, 这笔交易)」评价边：GET 读我的 / POST 创建 / DELETE 删除 ——

  router.get(REVIEW_EDGE_PATH, async (c) => {
    const transactionId = requireTransactionId(c)
    if (!transactionId) return transactionNotFoundResponse(c)
    const userId = requireUserId(c)
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '未登录'), 401)

    try {
      return c.json(await service.getMyReview(userId, transactionId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post(REVIEW_EDGE_PATH, async (c) => {
    const transactionId = requireTransactionId(c)
    if (!transactionId) return transactionNotFoundResponse(c)
    const userId = requireUserId(c)
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '未登录'), 401)

    let raw: unknown = null
    try {
      raw = await c.req.json()
    } catch {
      // 空体 / 非 JSON 按参数不合法处理，而不是让 Hono 抛 500。
    }
    const parsed = TransactionReviewCreateInputSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      // 201 Created：评价行是本次请求新建的资源（重复评价 409，不会静默变成 200）。
      return c.json(await service.createReview(userId, transactionId, parsed.data), 201)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.delete(REVIEW_EDGE_PATH, async (c) => {
    const transactionId = requireTransactionId(c)
    if (!transactionId) return transactionNotFoundResponse(c)
    const userId = requireUserId(c)
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '未登录'), 401)

    try {
      return c.json(await service.deleteMyReview(userId, transactionId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // —— #475 配图上传链（presign → 直传 → confirm） ——

  router.post(MEDIA_PRESIGN_PATH, guard.write, async (c) => {
    const transactionId = requireTransactionId(c)
    if (!transactionId) return transactionNotFoundResponse(c)
    const userId = requireUserId(c)
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '未登录'), 401)

    let raw: unknown = null
    try {
      raw = await c.req.json()
    } catch {
      // 空体 / 非 JSON 按参数不合法处理（与评价边 POST 同款）。
    }
    const parsed = ReviewMediaPresignRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.media.presign(userId, transactionId, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post(MEDIA_CONFIRM_PATH, guard.write, async (c) => {
    const transactionId = requireTransactionId(c)
    if (!transactionId) return transactionNotFoundResponse(c)
    const userId = requireUserId(c)
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '未登录'), 401)

    let raw: unknown = null
    try {
      raw = await c.req.json()
    } catch {
      // 同上。
    }
    const parsed = ReviewMediaConfirmRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.media.confirm(userId, transactionId, parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // —— 一笔交易的两方评价（订单详情对账） ——

  router.get(REVIEWS_OF_PATH, async (c) => {
    const transactionId = requireTransactionId(c)
    if (!transactionId) return transactionNotFoundResponse(c)
    const userId = requireUserId(c)
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '未登录'), 401)

    try {
      return c.json(await service.listReviewsOf(userId, transactionId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}
