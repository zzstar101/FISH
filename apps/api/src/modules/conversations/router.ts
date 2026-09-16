import {
  conversationCreateInputSchema,
  conversationListQuerySchema,
} from '@fish/contracts/chat/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { type ConversationService, ConversationServiceError } from './service'

export type ConversationsRouterOptions = {
  service: ConversationService
  /** 会话没有匿名路径（列表只含本人的会话），整条路由挂 requireAuth（与 matching 同构）。 */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 app.onError（与 matching router 同构）。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ConversationServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createConversationsRouter({ service, requireAuth }: ConversationsRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  // 挂载点是 /conversations（app.ts），router 内部用 /。
  app.post('/', requireAuth, async (c) => {
    const parsed = conversationCreateInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      const { conversation, created } = await service.createOrGetConversation(
        c.get('userId'),
        parsed.data,
      )
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

  app.get('/:id', requireAuth, async (c) => {
    const id = c.req.param('id')
    if (!UUID_PATTERN.test(id)) {
      return c.json(errorBody('CONVERSATION_NOT_FOUND', '会话不存在'), 404)
    }

    try {
      return c.json(await service.getConversation(c.get('userId'), id), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  app.post('/:id/read', requireAuth, async (c) => {
    try {
      return c.json(await service.markRead(c.get('userId'), c.req.param('id')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return app
}
