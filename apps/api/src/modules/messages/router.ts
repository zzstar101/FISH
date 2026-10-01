import { messageListQuerySchema, messageSendBodySchema } from '@fish/contracts/chat/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { ConversationIdSchema, MessageIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
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
const parseConversationId = (raw: string) =>
  ConversationIdSchema.safeParse(raw).success
    ? decodePublicId(PUBLIC_ID_PREFIX.conversation, raw)
    : null

const conversationNotFound = (c: Context) =>
  c.json(errorBody('CONVERSATION_NOT_FOUND', '会话不存在'), 404)

/** 路径里的消息 id 同理：非公开 id 形状直接按「消息不存在」处理，不落 SQL。 */
const parseMessageId = (raw: string) =>
  MessageIdSchema.safeParse(raw).success ? decodePublicId(PUBLIC_ID_PREFIX.message, raw) : null

/**
 * 挂载点也是 /conversations（与 conversations router 并列 route 到同一路径前缀，
 * Hono 按注册顺序匹配、互不冲突）：本 router 只提供 `/:id/messages` 两个端点，
 * 对外路径即契约的 `CHAT_ROUTES.messages(id)`。
 */
export function createMessagesRouter({ service, requireAuth, guard }: MessagesRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/:id/messages', requireAuth, async (c) => {
    const id = parseConversationId(c.req.param('id') ?? '')
    if (!id) return conversationNotFound(c)
    const parsed = messageListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(
        await service.listMessages(c.get('userId'), id, {
          ...parsed.data,
          before: parsed.data.before
            ? decodePublicId(PUBLIC_ID_PREFIX.message, parsed.data.before)
            : undefined,
        }),
        200,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.post('/:id/messages', requireAuth, guard.write, async (c) => {
    const id = parseConversationId(c.req.param('id') ?? '')
    if (!id) return conversationNotFound(c)
    // 请求体是 TEXT / LISTING 的联合（#359）；两者都是 strictObject 且字段不重叠，无歧义。
    const parsed = messageSendBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(
        parsed.data.type === 'LISTING'
          ? await service.sendListingMessage(c.get('userId'), id, parsed.data)
          : await service.sendTextMessage(c.get('userId'), id, parsed.data),
        201,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  /**
   * 撤回（#359 3c）：204 无响应体；对已撤回消息幂等。
   * 非公开 id 形状与「不存在」同码（404 MESSAGE_NOT_FOUND），不泄漏 id 空间。
   */
  app.post('/:id/messages/:messageId/recall', requireAuth, guard.write, async (c) => {
    const id = parseConversationId(c.req.param('id') ?? '')
    if (!id) return conversationNotFound(c)
    const messageId = parseMessageId(c.req.param('messageId') ?? '')
    if (!messageId) return c.json(errorBody('MESSAGE_NOT_FOUND', '消息不存在'), 404)
    try {
      await service.recallMessage(c.get('userId'), id, messageId)
      return c.body(null, 204)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return app
}
