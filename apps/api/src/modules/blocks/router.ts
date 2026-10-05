import { BLOCK_ROUTES } from '@fish/contracts/blocks/routes'
import { MyBlocksQuerySchema } from '@fish/contracts/blocks/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { UserIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type BlockService, BlockServiceError } from './service'

type BlockVariables = { userId: string }
type BlockContext = Context<{ Variables: BlockVariables }>

export type BlockUserIdResolver = (context: BlockContext) => string | undefined

export type BlocksRouterOptions = {
  service: BlockService
  /**
   * 必须从认证 middleware 写入的**服务端可信 context** 读取当前用户 id，禁止信任请求头
   * （follows 同款约定）。接线时 `app.ts` 已对两条路径挂 `auth.requireAuth`；
   * 这里的兜底保证漏挂守卫时**失败关闭**（401），而不是把匿名请求当成本人。
   */
  getUserId: BlockUserIdResolver
}

/**
 * 路径参数必须是规范的用户 Public ID。非法输入与不存在同码 404（`USER_NOT_FOUND`）：
 * 不给「格式错」与「不存在」留可区分的响应（follows 同款取舍）。
 */
function requireTargetId(c: BlockContext): string | null {
  const parsed = UserIdSchema.safeParse(c.req.param('userId'))
  return parsed.success ? decodePublicId(PUBLIC_ID_PREFIX.user, parsed.data) : null
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（follows 同构）。 */
function toErrorResponse(c: BlockContext, error: unknown): Response {
  if (error instanceof BlockServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

const userNotFoundResponse = (c: BlockContext) =>
  c.json(errorBody('USER_NOT_FOUND', '用户不存在或不可见'), 404)

const MY_BLOCKS_PATH = BLOCK_ROUTES.myBlocks
const RELATION_PATH = BLOCK_ROUTES.blockRelation(':userId')

export function createBlocksRouter({ service, getUserId }: BlocksRouterOptions) {
  const router = new Hono<{ Variables: BlockVariables }>()

  // 本域**没有匿名路径**（拉黑关系是「我」与某个人的有向边）。
  //
  // ⚠️ 中间件**必须逐路径挂，不能用 `router.use('*', …)`**：本 router 挂载在根路径 `/`
  // （两个端点分属 `/me/...` 与 `/users/...`，没有共同前缀），而 Hono 的 `app.route('/',
  // sub)` 会把 sub 的 `use('*')` 提升成**父 app 的全局中间件**——连 `/health` 都会 401
  // （follows 实测过的坑，见 follows/router.ts 注释）。
  const requireViewer = async (c: BlockContext, next: () => Promise<void>) => {
    const userId = getUserId(c)
    // `UNAUTHENTICATED` 与 auth 的 requireAuth 同码：前端只有这一个「跳登录」信号。
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', userId)
    await next()
  }

  router.use(MY_BLOCKS_PATH, requireViewer)
  router.use(RELATION_PATH, requireViewer)

  router.get(MY_BLOCKS_PATH, async (c) => {
    const parsed = MyBlocksQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.listMyBlocks(c.get('userId'), parsed.data), 200)
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
      return c.json(await service.block(c.get('userId'), targetId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.delete(RELATION_PATH, async (c) => {
    const targetId = requireTargetId(c)
    if (!targetId) return userNotFoundResponse(c)

    try {
      return c.json(await service.unblock(c.get('userId'), targetId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type BlocksRouter = ReturnType<typeof createBlocksRouter>
