import {
  conversationCreateInputSchema,
  conversationListQuerySchema,
} from '@fish/contracts/chat/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { ConversationIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { type ConversationService, ConversationServiceError } from './service'

export type ConversationsRouterOptions = {
  service: ConversationService
  /** 会话没有匿名路径（列表只含本人的会话），整条路由挂 requireAuth（与 matching 同构）。 */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** #73 治理守卫：发起会话前检查封禁（会话属于 `write` 作用域）。 */
  guard: RestrictionGuard
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 app.onError（与 matching router 同构）。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ConversationServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

const parseConversationId = (raw: string) =>
  ConversationIdSchema.safeParse(raw).success
    ? decodePublicId(PUBLIC_ID_PREFIX.conversation, raw)
    : null

export function createConversationsRouter({
  service,
  requireAuth,
  guard,
}: ConversationsRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  // 挂载点是 /conversations（app.ts），router 内部用 /。
  app.post('/', requireAuth, guard.write, async (c) => {
    const parsed = conversationCreateInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      const { conversation, created } = await service.createOrGetConversation(c.get('userId'), {
        listingId: decodePublicId(PUBLIC_ID_PREFIX.listing, parsed.data.listingId),
      })
      return c.json(conversation, created ? 201 : 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.get('/', requireAuth, async (c) => {
    const parsed = conversationListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      // 游标合法性与解码在 service（decodeCursor null → 422），路由只透传原始串。
      return c.json(await service.listConversations(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 未读总数是静态路径，必须注册在 `GET /:id` **之前**：Hono 按注册顺序匹配，
  // 排在后面会被 `/:id` 当成会话 id 吃掉（`unread-count` 不是合法 uuid，直接 404）。
  app.get('/unread-count', requireAuth, async (c) => {
    try {
      return c.json(await service.getUnreadCount(c.get('userId')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.get('/:id', requireAuth, async (c) => {
    const id = parseConversationId(c.req.param('id') ?? '')
    if (!id) {
      return c.json(errorBody('CONVERSATION_NOT_FOUND', '会话不存在'), 404)
    }

    try {
      return c.json(await service.getConversation(c.get('userId'), id), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.post('/:id/read', requireAuth, guard.write, async (c) => {
    const id = parseConversationId(c.req.param('id') ?? '')
    if (!id) {
      return c.json(errorBody('CONVERSATION_NOT_FOUND', '会话不存在'), 404)
    }

    try {
      return c.json(await service.markRead(c.get('userId'), id), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return app
}
