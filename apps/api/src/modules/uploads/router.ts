import {
  UploadConfirmRequestSchema,
  UploadPresignRequestSchema,
} from '@fish/contracts/listings/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { createUploadService, type UploadService, UploadServiceError } from './service'
import type { MediaStorage } from './storage'

export type UploadsRouterOptions = {
  storage: MediaStorage
  /** 两个端点都要登录（契约 §0.2 的写接口表）。 */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
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

  router.post('/presign', options.requireAuth, async (c) => {
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

  router.post('/confirm', options.requireAuth, async (c) => {
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
