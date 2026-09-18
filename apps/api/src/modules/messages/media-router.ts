import {
  mediaListQuerySchema,
  mediaMessageInputSchema,
  mediaPresignInputSchema,
} from '@fish/contracts/chat/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { MediaStorage } from '../uploads/storage'
import type { MediaMessageService } from './media-service'
import { MediaMessageServiceError } from './media-service'

export type MediaRouterOptions = {
  service: MediaMessageService
  storage: MediaStorage
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
}

function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null)
}

/**
 * 路径参数必须是 UUID。
 *
 * 否则它会被当成绑定参数走到 SQL 的 `::uuid` 转换：非法字串让 PG 报 `22P02` → 500，
 * 而契约要求"不存在"语义（评审 F-3）。与 media-store 里的 `::uuid` 位置一一对应。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function conversationNotFound(c: Context) {
  return c.json(errorBody('CONVERSATION_NOT_FOUND', '会话不存在'), 404)
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof MediaMessageServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

export function createMediaRouter({ service, storage, requireAuth }: MediaRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.post('/:id/media/presign', requireAuth, async (c) => {
    if (!UUID_RE.test(c.req.param('id'))) return conversationNotFound(c)
    const parsed = mediaPresignInputSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.presign(c.get('userId'), c.req.param('id'), parsed.data), 200)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/:id/media', requireAuth, async (c) => {
    if (!UUID_RE.test(c.req.param('id'))) return conversationNotFound(c)
    const parsed = mediaMessageInputSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.create(c.get('userId'), c.req.param('id'), parsed.data), 201)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/:id/media', requireAuth, async (c) => {
    if (!UUID_RE.test(c.req.param('id'))) return conversationNotFound(c)
    const parsed = mediaListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(errorBody('VALIDATION_FAILED', 'limit 或 cursor 不合法'), 422)
    }
    try {
      return c.json(await service.list(c.get('userId'), c.req.param('id'), parsed.data), 200)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/:conversationId/media/:mediaId', requireAuth, async (c) => {
    if (!UUID_RE.test(c.req.param('conversationId')) || !UUID_RE.test(c.req.param('mediaId'))) {
      return c.json(errorBody('MEDIA_NOT_FOUND', '媒体不存在'), 404)
    }
    try {
      const object = await service.getObject(
        c.get('userId'),
        c.req.param('conversationId'),
        c.req.param('mediaId'),
      )
      if (!storage.getObject) return c.json(errorBody('MEDIA_NOT_FOUND', '媒体不存在'), 404)
      const file = storage.getObject(object.key)
      return new Response(file.stream, {
        headers: {
          'Content-Type': object.contentType || file.contentType,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  return app
}
