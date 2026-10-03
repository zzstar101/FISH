import { errorBody, validationDetails } from '@fish/contracts/system/error'
import { VIEW_HISTORY_ROUTES } from '@fish/contracts/view-history/routes'
import { MyViewHistoryQuerySchema } from '@fish/contracts/view-history/schema'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { type ViewHistoryService, ViewHistoryServiceError } from './service'

type ViewHistoryVariables = { userId: string }
type ViewHistoryContext = Context<{ Variables: ViewHistoryVariables }>

export type ViewHistoryUserIdResolver = (context: ViewHistoryContext) => string | undefined

export type ViewHistoryRouterOptions = {
  service: ViewHistoryService
  /**
   * 必须从认证 middleware 写入的**服务端可信 context** 读取当前用户 id，禁止信任请求头
   * （与 favorites / follows 同一约定）。接线时 `app.ts` 已对路径挂 `auth.requireAuth`；
   * 这里的兜底保证漏挂守卫时**失败关闭**（401），而不是把匿名请求当成本人。
   */
  getUserId: ViewHistoryUserIdResolver
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（与 favorites 的 router 同构）。 */
function toErrorResponse(c: ViewHistoryContext, error: unknown): Response {
  if (error instanceof ViewHistoryServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  throw error
}

const MY_VIEW_HISTORY_PATH = VIEW_HISTORY_ROUTES.myViewHistory

export function createViewHistoryRouter({ service, getUserId }: ViewHistoryRouterOptions) {
  const router = new Hono<{ Variables: ViewHistoryVariables }>()

  // 本域**没有匿名路径**：浏览记录是「我」的资产，浏览者是谁决定了看得到哪一份数据。
  //
  // ⚠️ 中间件**必须逐路径挂，不能用 `router.use('*', …)`**：本 router 挂载在根路径 `/`
  // （路径是 `/me/view-history`），而 Hono 的 `app.route('/', sub)` 会把 sub 的
  // `use('*')` 提升成**父 app 的全局中间件** —— 结果是每个请求（连 `/health` 也是）
  // 都先过一道 401。逐路径挂既保留「漏挂守卫就失败关闭」的兜底，又不会越界。
  const requireViewer = async (c: ViewHistoryContext, next: () => Promise<void>) => {
    const userId = getUserId(c)
    // `UNAUTHENTICATED` 与 auth 的 requireAuth 同码：前端只有这一个「跳登录」信号。
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', userId)
    await next()
  }

  router.use(MY_VIEW_HISTORY_PATH, requireViewer)

  router.get(MY_VIEW_HISTORY_PATH, async (c) => {
    const parsed = MyViewHistoryQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.listMine(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.delete(MY_VIEW_HISTORY_PATH, async (c) => {
    try {
      return c.json(await service.clearMine(c.get('userId')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type ViewHistoryRouter = ReturnType<typeof createViewHistoryRouter>
