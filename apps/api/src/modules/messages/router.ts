import { messageListQuerySchema, messageSendInputSchema } from '@fish/contracts/chat/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { type MessageService, MessageServiceError } from './service'

export type MessagesRouterOptions = {
  service: MessageService
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** #73 治理守卫：发消息前检查封禁（含文本与媒体消息，都属 `write` 作用域）。 */
  guard: RestrictionGuard
}

function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof MessageServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/**
 * 路径参数必须是 UUID：否则它作为绑定参数走到 SQL 的 `::uuid` 转换，PG 抛 `22P02` → 500，
 * 而契约对「会话 id 不存在」的口径是 404 `CONVERSATION_NOT_FOUND`（与 #152 的 read 同款）。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const conversationNotFound = (c: Context) =>
  c.json(errorBody('CONVERSATION_NOT_FOUND', '会话不存在'), 404)

/**
 * 挂载点也是 /conversations（与 conversations router 并列 route 到同一路径前缀，
 * Hono 按注册顺序匹配、互不冲突）：本 router 只提供 `/:id/messages` 两个端点，
 * 对外路径即契约的 `CHAT_ROUTES.messages(id)`。
 */
export function createMessagesRouter({ service, requireAuth, guard }: MessagesRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/:id/messages', requireAuth, async (c) => {
    if (!UUID_PATTERN.test(c.req.param('id'))) return conversationNotFound(c)
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

  app.post('/:id/messages', requireAuth, guard.write, async (c) => {
    if (!UUID_PATTERN.test(c.req.param('id'))) return conversationNotFound(c)
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
