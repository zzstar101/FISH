import { FOLLOW_ROUTES } from '@fish/contracts/follows/routes'
import { MyFollowingQuerySchema } from '@fish/contracts/follows/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { UserIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type FollowService, FollowServiceError } from './service'

type FollowVariables = { userId: string }
type FollowContext = Context<{ Variables: FollowVariables }>

export type FollowUserIdResolver = (context: FollowContext) => string | undefined

export type FollowsRouterOptions = {
  service: FollowService
  /**
   * 必须从认证 middleware 写入的**服务端可信 context** 读取当前用户 id，禁止信任请求头
   * （与 #7 / #23 同一约定）。接线时 `app.ts` 已对两条路径挂 `auth.requireAuth`；
   * 这里的兜底保证漏挂守卫时**失败关闭**（401），而不是把匿名请求当成本人。
   */
  getUserId: FollowUserIdResolver
}

/**
 * 路径参数必须是规范的用户 Public ID。非法输入与不存在同码 404（`USER_NOT_FOUND`）：
 * 不给「格式错」与「不存在」留可区分的响应，否则这条登录可达的路径就成了一份 id 空间探针
 * （与 `users/router.ts` 的 `requireUserId` 同一取舍）。
 */
function requireTargetId(c: FollowContext): string | null {
  const parsed = UserIdSchema.safeParse(c.req.param('userId'))
  return parsed.success ? decodePublicId(PUBLIC_ID_PREFIX.user, parsed.data) : null
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（与 #6 / #23 的 router 同构）。 */
function toErrorResponse(c: FollowContext, error: unknown): Response {
  if (error instanceof FollowServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

const userNotFoundResponse = (c: FollowContext) =>
  c.json(errorBody('USER_NOT_FOUND', '用户不存在或不可见'), 404)

/**
 * 路由 pattern 从契约常量派生：把参数名当占位 id 传进去（禁止在别处硬编码路径）。
 * 挂载点是根路径 `/`（`app.ts`），两个 pattern 分别在 `/me/following` 与
 * `/users/:userId/follow` 之下，与匿名可读的 `users` router 不冲突（后者只有
 * `.../public` 与 `.../listings` 两条子路径）。
 */
const MY_FOLLOWING_PATH = FOLLOW_ROUTES.myFollowing
const RELATION_PATH = FOLLOW_ROUTES.followRelation(':userId')

export function createFollowsRouter({ service, getUserId }: FollowsRouterOptions) {
  const router = new Hono<{ Variables: FollowVariables }>()

  // 本域**没有匿名路径**：关注关系是「我」与某个人的有向边，读与写都要登录。
  //
  // ⚠️ 中间件**必须逐路径挂，不能用 `router.use('*', …)`**：本 router 挂载在根路径 `/`
  // （两个端点分属 `/me/...` 与 `/users/...`，没有共同前缀），而 Hono 的 `app.route('/',
  // sub)` 会把 sub 的 `use('*')` 提升成**父 app 的全局中间件** —— 结果是每个请求（连
  // `/health` 也是）都先过一道 401。实测：`router.use('*')` 时 `GET /health` 返回 401。
  // 逐路径挂既保留了「漏挂守卫就失败关闭」的兜底，又不会越界。
  //
  // 这里只读父层 `auth.requireAuth` 写入的可信 context，不再查一次库（守卫由 `app.ts` 挂）。
  const requireViewer = async (c: FollowContext, next: () => Promise<void>) => {
    const userId = getUserId(c)
    // `UNAUTHENTICATED` 与 auth 的 requireAuth 同码：前端只有这一个「跳登录」信号。
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', userId)
    await next()
  }

  router.use(MY_FOLLOWING_PATH, requireViewer)
  router.use(RELATION_PATH, requireViewer)

  router.get(MY_FOLLOWING_PATH, async (c) => {
    const parsed = MyFollowingQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.listMyFollowing(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get(RELATION_PATH, async (c) => {
    const targetId = requireTargetId(c)
    if (!targetId) return userNotFoundResponse(c)

    try {
      return c.json(await service.getState(c.get('userId'), targetId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post(RELATION_PATH, async (c) => {
    const targetId = requireTargetId(c)
    if (!targetId) return userNotFoundResponse(c)

    try {
      return c.json(await service.follow(c.get('userId'), targetId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.delete(RELATION_PATH, async (c) => {
    const targetId = requireTargetId(c)
    if (!targetId) return userNotFoundResponse(c)

    try {
      return c.json(await service.unfollow(c.get('userId'), targetId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type FollowsRouter = ReturnType<typeof createFollowsRouter>
