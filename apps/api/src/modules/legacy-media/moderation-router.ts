import {
  LegacyMediaAuditDecisionInputSchema,
  LegacyMediaAuditQueueQuerySchema,
} from '@fish/contracts/legacy-media/moderation'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { decodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { type Context, Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { MediaStorage } from '../uploads/storage'
import { type LegacyMediaAuditService, LegacyMediaAuditServiceError } from './moderation-service'

type Ctx = Context<{ Variables: AuthVariables }>

/**
 * 管理端存量图片补审（#694 审查 P1-2）。挂在 `/admin/legacy-media/audit`，与其它 /admin
 * 端点共用 requireAuth + requireAdmin；图片字节只经这里的管理员鉴权读取，不签公开 URL。
 *
 * 路由常量与契约同源（LEGACY_MEDIA_AUDIT_ROUTES），前端不必自己拼路径。
 */
export function createLegacyMediaAuditRouter(options: {
  service: LegacyMediaAuditService
  storage: MediaStorage
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }>
}) {
  const router = new Hono<{ Variables: AuthVariables }>()
  const { service, storage } = options
  router.use('*', options.requireAuth)
  router.use('*', options.requireAdmin)

  /** 公开 ID → 内部 UUID；形态不对按「记录不存在」404，不把解码细节暴露给调用方。 */
  const itemIdOf = (raw: string): string => {
    if (!isPublicId(PUBLIC_ID_PREFIX.legacyMediaAuditItem, raw)) {
      throw new LegacyMediaAuditServiceError('LEGACY_MEDIA_AUDIT_NOT_FOUND', 404, '补审记录不存在')
    }
    return decodePublicId(PUBLIC_ID_PREFIX.legacyMediaAuditItem, raw)
  }

  const fail = (err: unknown, c: Ctx) => {
    if (err instanceof LegacyMediaAuditServiceError) {
      return c.json(errorBody(err.code, err.message), err.status)
    }
    return undefined
  }

  const invalid = (c: Ctx, issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
    c.json(errorBody('VALIDATION_FAILED', '请求参数校验失败', validationDetails(issues)), 422)

  router.get('/', async (c) => {
    try {
      const parsed = LegacyMediaAuditQueueQuerySchema.safeParse({
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

  router.get('/:itemId', async (c) => {
    try {
      const item = await service.detail(itemIdOf(c.req.param('itemId')))
      if (!item) {
        c.status(404)
        return c.json(errorBody('LEGACY_MEDIA_AUDIT_NOT_FOUND', '补审记录不存在'))
      }
      return c.json(item)
    } catch (err) {
      const response = fail(err, c)
      if (response) return response
      throw err
    }
  })

  router.post('/:itemId/decision', async (c) => {
    try {
      const parsed = LegacyMediaAuditDecisionInputSchema.safeParse(
        await c.req.json().catch(() => null),
      )
      if (!parsed.success) return invalid(c, parsed.error.issues)
      return c.json(
        await service.decide(itemIdOf(c.req.param('itemId')), parsed.data, c.get('userId')),
      )
    } catch (err) {
      const response = fail(err, c)
      if (response) return response
      throw err
    }
  })

  router.get('/:itemId/media', async (c) => {
    try {
      const snapshot = await service.findMedia(itemIdOf(c.req.param('itemId')))
      if (!snapshot) {
        c.status(404)
        return c.json(errorBody('LEGACY_MEDIA_AUDIT_NOT_FOUND', '补审图片不存在'))
      }
      if (!storage.getObject) {
        c.status(503)
        return c.json(errorBody('LEGACY_MEDIA_AUDIT_UNAVAILABLE', '对象存储未提供读取能力'))
      }
      const object = storage.getObject(snapshot.objectKey)
      if (!object) {
        c.status(404)
        return c.json(errorBody('LEGACY_MEDIA_AUDIT_NOT_FOUND', '补审图片已被清理'))
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
