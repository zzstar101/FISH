import {
  mediaListQuerySchema,
  mediaMessageInputSchema,
  mediaPresignInputSchema,
} from '@fish/contracts/chat/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { decodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import type { MediaStorage } from '../uploads/storage'
import type { MediaMessageService } from './media-service'
import { MediaMessageServiceError } from './media-service'

export type MediaRouterOptions = {
  service: MediaMessageService
  storage: MediaStorage
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /**
   * 封禁写守卫（#73 PR3）。
   *
   * 这里**必须**传入并在两个 POST 上生效：文字消息走 `messagesRouter` 的
   * `guard.write`，而图片 / 语音走同一套「上传→发消息」链路的 media 路由。
   * 漏挂的后果是封禁只挡住文字，被封用户仍能通过 `POST /:id/media/presign`
   * + `POST /:id/media` 发图——限制在服务端就是空的（评审 M2）。
   *
   * GET 不挂：封禁只禁写、只开放读（#73 决策 Q6）。
   */
  guard: RestrictionGuard
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
function conversationId(raw: string): string | null {
  return isPublicId(PUBLIC_ID_PREFIX.conversation, raw)
    ? decodePublicId(PUBLIC_ID_PREFIX.conversation, raw)
    : null
}

function conversationNotFound(c: Context) {
  return c.json(errorBody('CONVERSATION_NOT_FOUND', '会话不存在'), 404)
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof MediaMessageServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/** 单范围读取；忽略未知/多范围语法（回全量），不可满足的合法范围返回 416。 */
function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null
  const startValue = Number(match[1])
  const endValue = Number(match[2])
  if (!Number.isSafeInteger(startValue) || !Number.isSafeInteger(endValue)) return 'unsatisfiable'
  if (!match[1]) {
    if (endValue === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - endValue), end: size - 1 }
  }
  const end = match[2] ? Math.min(endValue, size - 1) : size - 1
  if (startValue >= size || startValue > end) return 'unsatisfiable'
  return { start: startValue, end }
}

export function createMediaRouter({ service, storage, requireAuth, guard }: MediaRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.post('/:id/media/presign', requireAuth, guard.write, async (c) => {
    const id = conversationId(c.req.param('id') ?? '')
    if (!id) return conversationNotFound(c)
    const parsed = mediaPresignInputSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.presign(c.get('userId'), id, parsed.data), 200)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.post('/:id/media', requireAuth, guard.write, async (c) => {
    const id = conversationId(c.req.param('id') ?? '')
    if (!id) return conversationNotFound(c)
    const parsed = mediaMessageInputSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return c.json(await service.create(c.get('userId'), id, parsed.data), 201)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/:id/media', requireAuth, async (c) => {
    const id = conversationId(c.req.param('id') ?? '')
    if (!id) return conversationNotFound(c)
    const parsed = mediaListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(errorBody('VALIDATION_FAILED', 'limit 或 cursor 不合法'), 422)
    }
    try {
      return c.json(await service.list(c.get('userId'), id, parsed.data), 200)
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get('/:conversationId/media/:mediaId', requireAuth, async (c) => {
    const id = conversationId(c.req.param('conversationId') ?? '')
    const publicMediaId = c.req.param('mediaId')
    if (!id || !isPublicId(PUBLIC_ID_PREFIX.media, publicMediaId)) {
      return c.json(errorBody('MEDIA_NOT_FOUND', '媒体不存在'), 404)
    }
    try {
      const object = await service.getObject(
        c.get('userId'),
        id,
        decodePublicId(PUBLIC_ID_PREFIX.media, publicMediaId),
      )
      if (!storage.getObject) return c.json(errorBody('MEDIA_NOT_FOUND', '媒体不存在'), 404)
      // If-Range 未提供可验证的 validator 时回完整实体，不发送可能不匹配的分片。
      const range = byteRange(
        c.req.header('If-Range') ? undefined : c.req.header('Range'),
        object.size,
      )
      const headers = {
        'Content-Type': object.contentType,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      }
      if (range === 'unsatisfiable') {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${object.size}` },
        })
      }
      const file = storage.getObject(object.key, range ?? undefined)
      // 键形状不合法（例如修复前落库的脏行）按不存在处理，绝不落到存储层去归一化路径。
      if (file === null) return c.json(errorBody('MEDIA_NOT_FOUND', '媒体不存在'), 404)
      return new Response(file.stream, {
        status: range ? 206 : 200,
        headers: {
          ...headers,
          'Content-Length': String(range ? range.end - range.start + 1 : object.size),
          ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${object.size}` } : {}),
        },
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  return app
}
