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
import { reviewMediaKey } from './review-media'
import type { UploadService } from './service'
import { UploadServiceError } from './service'
import type { MediaStorage } from './storage'

export type UploadsRouterOptions = {
  storage: MediaStorage
  /** Purpose-separated AES key derived from the existing deployment secret. */
  legacyUrlSecret?: string
  /** 审核中图片的短期签名代理：与 `legacyUrlSecret` 同一个部署 secret、不同用途派生。 */
  reviewUrlSecret?: string
  /** 两个端点都要登录（契约 §0.2 的写接口表）。 */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** #73 治理守卫：上传确认前检查封禁（上传是写链的第一步，属 `write` 作用域）。 */
  guard: RestrictionGuard
  /**
   * #286：必传。`confirm` 现在需要审核 provider 与媒体对象存储（幂等表），router 无从自行推断
   * 这两个依赖，所以不再提供 `createUploadService({ storage })` 兜底。
   */
  service: UploadService
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
  const service = options.service
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

  const reviewSecret = options.reviewUrlSecret
  if (reviewSecret) {
    /**
     * #286 复审 blocker 2：审核中图片的**私有**读入口。
     *
     * 不是"公开直链的替代品"，而是对象级访问控制的最小实现：路径里只有密文令牌，键与过期时刻都在
     * 密文内，`reviewMediaKey` 校验签名与 TTL 后才去取对象。没有会话鉴权是刻意的 —— 微信小程序
     * 的原生 `<Image>` 不带 cookie（`apps/miniapp/src/lib/session.ts` 明写无 Bearer），会话鉴权代理
     * 在端上根本显示不出来；而审核队列页、卖家自己的「我发布的」必须看得到图。
     * 因此这里的授权载体是**不可猜、会过期、且不泄露对象键**的 capability URL。
     */
    router.get('/media/:token', async (c) => {
      const key = reviewMediaKey(c.req.param('token'), reviewSecret, Math.floor(Date.now() / 1000))
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
          // 私有：不允许共享缓存留存；300s 短于令牌 TTL(900s)，端上重复渲染不必重取。
          'Cache-Control': 'private, max-age=300',
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
