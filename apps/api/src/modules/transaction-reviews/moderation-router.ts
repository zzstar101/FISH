import { errorBody, validationDetails } from '@fish/contracts/system/error'
import {
  ReviewModerationDecisionInputSchema,
  ReviewModerationQueueQuerySchema,
} from '@fish/contracts/transaction-reviews/moderation'
import { decodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { type Context, Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { MediaStorage } from '../uploads/storage'
import { type ReviewModerationService, ReviewModerationServiceError } from './moderation-service'

type Ctx = Context<{ Variables: AuthVariables }>

/**
 * 管理端评价图片待审（#694 M5c）。挂载在 `/admin/reviews/moderation`，与其它 /admin 端点
 * 共用 requireAuth + requireAdmin；图片字节只经这里的管理员鉴权读取，不签公开 URL。
 */
export function createReviewModerationRouter(options: {
  service: ReviewModerationService
  storage: MediaStorage
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }>
}) {
  const router = new Hono<{ Variables: AuthVariables }>()
  const { service, storage } = options
  router.use('*', options.requireAuth)
  router.use('*', options.requireAdmin)

  /** 公开 ID → 内部 UUID；形态不对按「记录不存在」404，不把解码细节暴露给调用方。 */
  const recordIdOf = (raw: string): string => {
    if (!isPublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, raw)) {
      throw new ReviewModerationServiceError('REVIEW_MODERATION_NOT_FOUND', 404, '待审记录不存在')
    }
    return decodePublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, raw)
  }

  const fail = (err: unknown, c: Ctx) => {
    if (err instanceof ReviewModerationServiceError) {
      return c.json(errorBody(err.code, err.message), err.status)
    }
    return undefined
  }

  const invalid = (c: Ctx, issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
    c.json(errorBody('VALIDATION_FAILED', '请求参数校验失败', validationDetails(issues)), 422)

  router.get('/', async (c) => {
    try {
      const parsed = ReviewModerationQueueQuerySchema.safeParse({
        cursor: c.req.query('cursor'),
        limit: c.req.query('limit'),
      })
      if (!parsed.success) return invalid(c, parsed.error.issues)
      return c.json(await service.list(parsed.data))
    } catch (err) {
      const response = fail(err, c)
      if (response) return response
      throw err
    }
  })

  router.post('/:recordId/decision', async (c) => {
    try {
      const parsed = ReviewModerationDecisionInputSchema.safeParse(
        await c.req.json().catch(() => null),
      )
      if (!parsed.success) return invalid(c, parsed.error.issues)
      return c.json(
        await service.decide(recordIdOf(c.req.param('recordId')), parsed.data, c.get('userId')),
      )
    } catch (err) {
      const response = fail(err, c)
      if (response) return response
      throw err
    }
  })

  router.get('/:recordId/media', async (c) => {
    try {
      const snapshot = await service.findMedia(recordIdOf(c.req.param('recordId')))
      if (!snapshot) {
        c.status(404)
        return c.json(errorBody('REVIEW_MODERATION_NOT_FOUND', '待审图片不存在'))
      }
      if (!storage.getObject) {
        c.status(503)
        return c.json(errorBody('REVIEW_MODERATION_UNAVAILABLE', '对象存储未提供读取能力'))
      }
      const object = storage.getObject(snapshot.objectKey)
      if (!object) {
        c.status(404)
        return c.json(errorBody('REVIEW_MODERATION_NOT_FOUND', '待审图片已被清理'))
      }
      c.header('Content-Type', snapshot.contentType)
      c.header('Cache-Control', 'private, no-store')
      c.header('X-Content-Type-Options', 'nosniff')
      return c.body(object.stream)
    } catch (err) {
      const response = fail(err, c)
      if (response) return response
      throw err
    }
  })

  return router
}
