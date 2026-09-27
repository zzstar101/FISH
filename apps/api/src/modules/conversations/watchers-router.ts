import { chatWatchersQuerySchema } from '@fish/contracts/chat/schema'
import { ListingIdSchema } from '@fish/contracts/listings/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { ConversationServiceError } from './service'
import type { ChatWatchersService } from './watchers-service'

/** `/listings/:id/watchers`：名单与总数仅卖家本人可读。 */
export function createChatWatchersRouter(options: {
  service: ChatWatchersService
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
}) {
  const router = new Hono<{ Variables: AuthVariables }>()
  router.get('/listings/:id/watchers', options.requireAuth, async (c) => {
    const id = ListingIdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json(errorBody('LISTING_NOT_FOUND', '商品不存在'), 404)
    const parsed = chatWatchersQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(
        await options.service.list(
          c.get('userId'),
          decodePublicId(PUBLIC_ID_PREFIX.listing, id.data),
          parsed.data,
        ),
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })
  return router
}

function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ConversationServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}
