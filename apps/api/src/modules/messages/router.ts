import { messageListQuerySchema, messageSendInputSchema } from '@fish/contracts/chat/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { type MessageService, MessageServiceError } from './service'

export type MessagesRouterOptions = {
  service: MessageService
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
}

function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof MessageServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/**
 * 挂载点也是 /conversations（与 conversations router 并列 route 到同一路径前缀，
 * Hono 按注册顺序匹配、互不冲突）：本 router 只提供 `/:id/messages` 两个端点，
 * 对外路径即契约的 `CHAT_ROUTES.messages(id)`。
 */
export function createMessagesRouter({ service, requireAuth }: MessagesRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/:id/messages', requireAuth, async (c) => {
    const parsed = messageListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(
        await service.listMessages(c.get('userId'), c.req.param('id'), parsed.data),
        200,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.post('/:id/messages', requireAuth, async (c) => {
    const parsed = messageSendInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(
        await service.sendTextMessage(c.get('userId'), c.req.param('id'), parsed.data),
        201,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return app
}
