import { ACCOUNT_DELETION_ROUTES } from '@fish/contracts/account-deletion/routes'

/**
 * 冷静期内「还能写什么」的**唯一**判据（Issue #464，Owner 冻结口径 Q12 / Q13）。
 *
 * ## 为什么是白名单，而不是给每个业务模块加一句判断
 *
 * 冻结口径是「申请之后一切写操作都拒，只有登出 / 重新登录 / 撤回申请例外」。反过来写
 * （枚举被禁的写入口）就会漏：`app.ts` 里挂了几十个写路由，将来新增一个没人记得来加一条。
 * 这里改成**默认拒绝**：非安全方法一律拒，白名单是唯一的放行口。于是新模块天然被拦，
 * 漏判只可能表现为「某个入口被误拦」，而不是「某个入口没被拦」。
 *
 * ## 判据与执行分离
 *
 * 执行点在 `apps/api/src/modules/auth/middleware.ts` 的 `requireAuth`（全部已认证请求的唯一
 * 入口），本文件只回答「这个请求该不该拒」。这样拦截面没有缺口（漏挂守卫不会漏网），
 * 而白名单又是个纯函数，能被单测逐条枚举 —— 包括 `app.ts` 那类「遍历全部已注册路由」的
 * 自维护断言（见 `apps/api/src/modules/account-deletion/router.test.ts`）。
 *
 * ## 未登录路径不受影响
 *
 * 本判据只在 `requireAuth` **之后**被问，所以 `/auth/login`、`/auth/register`、`/auth/logout`、
 * `/auth/wechat/scan/ticket/:ticket/exchange` 这些不挂守卫的入口根本走不到这里 ——
 * 冷静期内「登出」「重新登录」自然可用，不需要在白名单里重复列举。唯一需要显式放行的
 * 已认证写入口是**扫码登录确认**（`/auth/wechat/scan/ticket/:ticket/confirm`，挂 requireAuth）：
 * 用户在电脑端扫码换设备登录，正是冷静期内允许的动作。
 */

/** 安全方法：读请求全部放行（冷静期内读全开）。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 白名单：精确匹配的写路径（本域三条方法都落在同一个 URL 上）。 */
const ALLOWED_WRITE_PATHS: ReadonlySet<string> = new Set([ACCOUNT_DELETION_ROUTES.status])

/**
 * 白名单：带路径参数的写路径。
 *
 * 用正则而不是 `path-to-regexp`：只有一个入口，且必须与 `auth/router.ts` 里的
 * `router.post('/wechat/scan/ticket/:ticket/confirm', requireAuth, …)` 逐字对应。
 */
const ALLOWED_WRITE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/auth\/wechat\/scan\/ticket\/[^/]+\/confirm$/,
]

/**
 * 冷静期内的写请求是否应被拒（403 `ACCOUNT_DELETION_PENDING`）。
 *
 * `path` 用 Hono 的 `c.req.path`：所有路由都挂在根级（Web 侧的 `/api` 前缀由 Vite 代理
 * 剥离），所以这里看到的就是契约里的路径，不需要再去前缀。
 */
export function isAccountDeletionBlockedWrite(input: { method: string; path: string }): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false
  if (ALLOWED_WRITE_PATHS.has(input.path)) return false
  if (ALLOWED_WRITE_PATH_PATTERNS.some((pattern) => pattern.test(input.path))) return false
  return true
}
