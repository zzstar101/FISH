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
import { contentDigestOf, disputeMediaKey } from './dispute-media'
import { legacyMediaKey } from './legacy-url'
import { reviewMediaKey } from './review-media'
import type { UploadService } from './service'
import { UploadServiceError } from './service'
import type { MediaStorage } from './storage'

export type UploadsRouterOptions = {
  storage: MediaStorage
  /** Purpose-separated AES key derived from the existing deployment secret. */
  legacyUrlSecret?: string
  /**
   * #694 M8：legacy 图公开代理的可见性闸门。返回 false 时按不存在处理（404），
   * 用于把未审/REVIEW/BLOCK 的存量对象挡在公开读面之外；缺省表示不启用闸门。
   */
  isLegacyMediaReadable?: (objectKey: string) => Promise<boolean>
  /**
   * #694 审查 P1-1：可选身份解析（返回登录用户 id，匿名/无效会话返回 null）。
   *
   * 刻意不挂 `requireAuth`：同一张旧 URL 既会被浏览器（带 cookie）加载，也会被小程序原生
   * `<Image>`（不带 cookie）加载。解析得到身份时按请求者判定授权，解析不到仍走匿名闸门。
   */
  resolveViewerId?: (c: Context) => Promise<string | null>
  /**
   * #694 审查 P1-1：授权读者判定 —— 管理员、该商品卖家、订单/纠纷当事人。
   * 仅当 `resolveViewerId` 解析出登录用户时调用；结果不成立时回落到匿名闸门。
   */
  isLegacyMediaVisibleToViewer?: (objectKey: string, viewerId: string) => Promise<boolean>
  /** 审核中图片的短期签名代理：与 `legacyUrlSecret` 同一个部署 secret、不同用途派生。 */
  reviewUrlSecret?: string
  /** #465 交易争议附件的短期签名代理：同上，用途派生串独立，令牌不能跨域重放。 */
  disputeUrlSecret?: string
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
      // #694 审查 P1-1：认证请求者先按关系判定（卖家/管理员/订单与纠纷当事人）。
      // 库存闸门只回答「匿名能不能看」，拿它挡授权读者会让卖家自己的页面也裂图。
      let viewerId: string | null = null
      if (options.resolveViewerId && options.isLegacyMediaVisibleToViewer) {
        try {
          viewerId = await options.resolveViewerId(c)
        } catch {
          viewerId = null
        }
      }
      let viewerCanRead = false
      if (viewerId !== null && options.isLegacyMediaVisibleToViewer) {
        try {
          viewerCanRead = await options.isLegacyMediaVisibleToViewer(key, viewerId)
        } catch {
          viewerCanRead = false
        }
      }
      // #694 M8：库存里存在该对象且未 ALLOW 时，匿名读一律 404；未进入库存的旧对象保持兼容。
      if (
        !viewerCanRead &&
        options.isLegacyMediaReadable &&
        !(await options.isLegacyMediaReadable(key))
      ) {
        return c.notFound()
      }
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
          // 授权读者看到的内容与匿名不同：不能被共享缓存留存（否则可能被缓存后发给匿名请求）。
          'Cache-Control': viewerCanRead ? 'private, no-store' : 'public, max-age=86400',
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

  const disputeSecret = options.disputeUrlSecret
  if (disputeSecret) {
    /**
     * #465：交易争议附件的**私有**读入口。
     *
     * 与审核中图片同一手法（同一个理由）：路径里只有密文令牌，对象键与过期时刻都在密文内，
     * `disputeMediaKey` 校验签名与 TTL 后才去取对象。没有会话鉴权是刻意的 —— 微信小程序的
     * 原生 `<Image>` 不带 cookie，而争议详情页必须能显示附件。
     * 授权载体是**不可猜、会过期、且不泄露对象键**的 capability URL。
     *
     * 注意这一层只能证明"持有令牌"，不能证明"有权看这条争议"：令牌只会通过
     * `DisputeAttachmentSchema.url` 发给当事人与管理员（服务层已完成可见性校验），
     * 且 `dispute-media/` 前缀本身不在匿名读白名单里。
     *
     * 令牌里还带着**确认时刻的字节摘要**：预签名 PUT 在有效期内可重复使用，光看
     * `stat` 分辨不出「对象被换过」。这里读完字节先核对摘要，对不上就不下发 ——
     * 否则裁决者看到的可能是被替换后的图（#465 验收第 4 条）。
     */
    router.get('/dispute-media/:token', async (c) => {
      const ticket = disputeMediaKey(
        c.req.param('token'),
        disputeSecret,
        Math.floor(Date.now() / 1000),
      )
      if (!ticket) return c.notFound()
      const stat = await options.storage.stat(ticket.key)
      if (
        !stat ||
        stat.size > MAX_IMAGE_BYTES ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(stat.contentType)
      ) {
        return c.notFound()
      }
      // 完整读一次（≤ 5MB）再核对摘要：流式转发就没机会在发出前发现被替换的字节。
      const bytes = await options.storage.readMediaBytes?.(ticket.key, MAX_IMAGE_BYTES)
      if (!bytes || bytes.length !== stat.size) return c.notFound()
      if (contentDigestOf(bytes) !== ticket.contentDigest) {
        console.warn('[api] 争议附件字节与台账摘要不符，已拒绝下发', ticket.key)
        return c.notFound()
      }
      return new Response(bytes, {
        headers: {
          'Content-Type': stat.contentType,
          'Content-Length': String(bytes.length),
          // 私有：不允许共享缓存留存；300s 短于令牌 TTL(900s)。
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
