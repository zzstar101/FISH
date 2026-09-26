import {
  MAX_IMAGE_BYTES,
  UploadConfirmRequestSchema,
  UploadPresignRequestSchema,
} from '@fish/contracts/listings/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { legacyMediaKey } from './legacy-url'
import { createUploadService, type UploadService, UploadServiceError } from './service'
import type { MediaStorage } from './storage'

export type UploadsRouterOptions = {
  storage: MediaStorage
  /** Purpose-separated AES key derived from the existing deployment secret. */
  legacyUrlSecret?: string
  /** 两个端点都要登录（契约 §0.2 的写接口表）。 */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** #73 治理守卫：上传确认前检查封禁（上传是写链的第一步，属 `write` 作用域）。 */
  guard: RestrictionGuard
  service?: UploadService
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof UploadServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

export function createUploadsRouter(options: UploadsRouterOptions) {
  const service = options.service ?? createUploadService({ storage: options.storage })
  const router = new Hono<{ Variables: AuthVariables }>()

  const legacySecret = options.legacyUrlSecret
  if (legacySecret) {
    router.get('/legacy/:token', async (c) => {
      const key = legacyMediaKey(c.req.param('token'), legacySecret)
      if (!key) return c.notFound()
      const stat = await options.storage.stat(key)
      if (
        !stat ||
        stat.size > MAX_IMAGE_BYTES ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(stat.contentType)
      ) {
        return c.notFound()
      }
      const object = options.storage.getObject?.(key)
      if (!object) return c.notFound()
      return new Response(object.stream, {
        headers: {
          'Content-Type': stat.contentType,
          'Content-Length': String(stat.size),
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    })
  }

  router.post('/presign', options.requireAuth, options.guard.write, async (c) => {
    const parsed = UploadPresignRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      // 契约 §3：VALIDATION_FAILED 必须带 details，前端据此把错误定位到输入框
      // （例如 contentType = image/heic 要能指出问题出在 contentType 字段）。
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.presign(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/confirm', options.requireAuth, options.guard.write, async (c) => {
    const parsed = UploadConfirmRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      // 契约 §3：VALIDATION_FAILED 必须带 details，前端据此把错误定位到输入框
      // （例如 contentType = image/heic 要能指出问题出在 contentType 字段）。
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.confirm(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type UploadsRouter = ReturnType<typeof createUploadsRouter>
