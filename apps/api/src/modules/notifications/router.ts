import { notificationListQuerySchema } from '@fish/contracts/notifications/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { decodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type NotificationService, NotificationServiceError } from './service'

type NotificationsVariables = { userId: string }
type NotificationsContext = Context<{ Variables: NotificationsVariables }>

export type NotificationUserIdResolver = (context: NotificationsContext) => string | undefined

export type NotificationsRouterOptions = {
  service: NotificationService
  /**
   * 必须从认证 middleware 写入的**服务端可信 context** 中读取当前用户 id，禁止信任请求头
   * （与 #7 的 `getUserId` 同一条约定）。
   *
   * 接线时 `app.ts` 已整条挂 `app.use('/notifications/*', auth.requireAuth)`；这里的兜底
   * 保证漏挂守卫时**失败关闭**（401），而不是把匿名请求当成本人。
   */
  getUserId: NotificationUserIdResolver
}

/** Wrong prefix, non-canonical encoding and bare UUID never reach the UUID column. */
function parseNotificationId(raw: string): string | null {
  return isPublicId(PUBLIC_ID_PREFIX.notification, raw)
    ? decodePublicId(PUBLIC_ID_PREFIX.notification, raw)
    : null
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（与 #6 / #8 的 router 同构）。 */
function toErrorResponse(c: NotificationsContext, error: unknown): Response {
  if (error instanceof NotificationServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/** 挂载点是 /notifications（app.ts），router 内部用 `/`。 */
export function createNotificationsRouter({ service, getUserId }: NotificationsRouterOptions) {
  const app = new Hono<{ Variables: NotificationsVariables }>()

  app.use('*', async (c, next) => {
    const userId = getUserId(c)
    // `UNAUTHENTICATED` 与 auth 的 requireAuth 用同一个码：前端只有这一个「跳登录」信号。
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', userId)
    await next()
  })

  app.get('/', async (c) => {
    const parsed = notificationListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }
    return c.json(await service.listNotifications(c.get('userId'), parsed.data), 200)
  })

  // 未读数是静态路径，与 `POST /:id/read` 不冲突（后者只注册了 POST）。放在通配参数路由
  // 之前是惯例：将来若加 `GET /:id`，这里不必依赖注册顺序的巧合。
  app.get('/unread-count', async (c) => {
    return c.json(await service.getUnreadCount(c.get('userId')), 200)
  })

  app.post('/:id/read', async (c) => {
    const id = parseNotificationId(c.req.param('id'))
    if (!id) return c.json(errorBody('NOTIFICATION_NOT_FOUND', '通知不存在'), 404)

    try {
      return c.json(await service.markRead(c.get('userId'), id), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return app
}
