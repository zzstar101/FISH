import { ACCOUNT_DELETION_ROUTES } from '@fish/contracts/account-deletion/routes'
import { RequestAccountDeletionSchema } from '@fish/contracts/account-deletion/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Db } from '@fish/db/client'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { SessionCookie } from '../auth/session'
import type { ConnectionHub } from '../realtime/hub'
import { AccountDeletionError, createAccountDeletionService } from './service'
import { createSqlAccountDeletionStore } from './store'

type AccountDeletionVariables = AuthVariables
type AccountDeletionContext = Context<{ Variables: AccountDeletionVariables }>

export type AccountDeletionRouterOptions = {
  db: Db
  /**
   * 与全站同一份 `requireAuth`（`auth.router` 里造的那个）。注销态下的写拦截就挂在这个
   * 中间件里（见 `auth/middleware.ts` 的 `accountDeletionWriteGuard`），所以这里**不需要**
   * 再挂 governance 的 `guard.write`：注销拦截与封禁拦截是两件事，前者对全部非安全方法生效。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** 读当前会话明文令牌：申请时要「保留本设备、撤销其它设备」，需要它的哈希。 */
  sessionCookie: SessionCookie
  /** 断开该用户全部 WS 连接（`POST` 成功后）。可选：测试与不关心实时的装配可以不传。 */
  hub?: Pick<ConnectionHub, 'closeUser'>
  now?: () => Date
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（与 #6 / #23 的 router 同构）。 */
function toErrorResponse(c: AccountDeletionContext, error: unknown): Response {
  if (error instanceof AccountDeletionError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/** 解析失败回 null：交给 schema 报 422，而不是让 JSON 解析异常变成 500（与 auth 同构）。 */
async function readJson(c: AccountDeletionContext): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

/**
 * 账号注销的三条端点（Issue #464）：同一路径上的读 / 申请 / 撤回。
 *
 * ⚠️ 中间件逐路径挂，不用 `router.use('*')`：本 router 挂在根路径 `/`，而 Hono 的
 * `app.route('/', sub)` 会把 sub 的 `use('*')` 提升成父 app 的全局中间件（见
 * `favorites/router.ts` 里的同一条注释）。路径从契约常量派生，禁止硬编码。
 */
export function createAccountDeletionModule(options: AccountDeletionRouterOptions) {
  const router = new Hono<{ Variables: AccountDeletionVariables }>()
  const service = createAccountDeletionService({
    store: createSqlAccountDeletionStore(options.db),
    hub: options.hub,
    now: options.now,
  })

  const PATH = ACCOUNT_DELETION_ROUTES.status

  router.use(PATH, options.requireAuth)

  // 读状态：冷静期内也必须可用 —— 用户要能看到「还有几天」「什么时候删」，才能决定是否撤回。
  router.get(PATH, async (c) => {
    try {
      return c.json(await service.status(c.get('userId')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 申请：幂等（重复申请不重置 7 天计时）。资格校验与商品下架在同一事务里完成。
  router.post(PATH, async (c) => {
    const parsed = RequestAccountDeletionSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      const result = await service.request(c.get('userId'), {
        sessionToken: options.sessionCookie.read(c),
      })
      return c.json(result, 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 撤回：幂等。已下架的商品**不**自动恢复上架（冻结口径 Q17），端上会在申请时就提示。
  router.delete(PATH, async (c) => {
    try {
      return c.json(await service.withdraw(c.get('userId')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return { router, service }
}

export type AccountDeletionModule = ReturnType<typeof createAccountDeletionModule>
