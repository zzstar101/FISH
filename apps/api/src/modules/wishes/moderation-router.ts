import {
  wishModerationDecisionInputSchema,
  wishModerationQueueQuerySchema,
} from '@fish/contracts/wishes/moderation'
import { decodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { WishModerationService } from './moderation-service'
import { WishModerationServiceError } from './moderation-service'

export function createWishModerationRouter(options: {
  service: WishModerationService
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }>
}) {
  const router = new Hono<{ Variables: AuthVariables }>()

  router.use('*', options.requireAuth)
  router.use('*', options.requireAdmin)

  router.get('/', async (c) => {
    const parsed = wishModerationQueueQuerySchema.safeParse({
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    })
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: '查询参数无效',
            details: parsed.error.issues,
          },
        },
        422,
      )
    }
    const result = await options.service.list(parsed.data)
    return c.json(result)
  })

  router.post('/:recordId/decision', async (c) => {
    const rawId = c.req.param('recordId')
    const recordId = isPublicId(PUBLIC_ID_PREFIX.wishModerationRecord, rawId)
      ? decodePublicId(PUBLIC_ID_PREFIX.wishModerationRecord, rawId)
      : null
    if (!recordId) {
      return c.json(
        { error: { code: 'WISH_MODERATION_NOT_FOUND', message: '待审记录不存在' } },
        404,
      )
    }
    const parsed = wishModerationDecisionInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: '审核参数无效',
            details: parsed.error.issues,
          },
        },
        422,
      )
    }
    const actorUserId = c.get('userId')
    try {
      const result = await options.service.decide(recordId, parsed.data, actorUserId)
      return c.json(result)
    } catch (error) {
      if (error instanceof WishModerationServiceError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.status)
      }
      throw error
    }
  })

  return router
}
