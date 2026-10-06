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
 * 执行点有**两处**，都只是「在正确的时机问这个纯函数」：
 *
 * 1. `apps/api/src/modules/auth/middleware.ts` 的 `requireAuth` —— 全部**已认证**请求的
 *    唯一入口。挂在这里保证「漏挂业务守卫」不会漏网。
 * 2. `apps/api/src/modules/account-deletion/optional-identity-guard.ts` —— 给那些
 *    **匿名可用、但会解析可选身份**的写入口（`POST /recommendations/events`、
 *    `POST /visual-search`、`POST /visual-search/uploads`）。它们不挂 `requireAuth`，
 *    所以执行点 1 够不着；而 `resolveViewerId` 在 `DELETION_REQUESTED` 时仍会返回真实
 *    userId，于是冷静期内它们照样带着归属落库（对抗性审查 B2 实证：202 + 带该 user_id
 *    的 `recommendation_events` 行）。执行点 2 补上这一层。
 *
 * 两处都问同一个纯函数，白名单只有一份；白名单又必须能被单测直接枚举 —— 包括
 * `app.ts` 那类「遍历全部已注册路由」的自维护断言（见
 * `apps/api/src/app.account-deletion.test.ts`）。
 *
 * ## 未登录路径不受影响
 *
 * 本判据只在身份**已经解析出来**之后被问（执行点 1 在 `requireAuth` 内部，执行点 2 先
 * `read(cookie)` 再解析），所以 `/auth/login`、`/auth/register`、`/auth/logout`、
 * `/auth/wechat/scan/ticket/:ticket/exchange` 这些不挂守卫的入口根本走不到这里 ——
 * 冷静期内「登出」「重新登录」自然可用，不需要在白名单里重复列举。唯一需要显式放行的
 * 已认证写入口是**扫码登录确认**（`/auth/wechat/scan/ticket/:ticket/confirm`，挂 requireAuth）：
 * 用户在电脑端扫码换设备登录，正是冷静期内允许的动作。
 */

/**
 * 冷静期内写请求被拒时的用户可见文案。
 *
 * 两处执行点（`requireAuth` 与可选身份守卫）必须逐字一致：端上按这个码提示「注销申请
 * 处理中，可先撤回申请」，两处文案漂移会让同一个状态在两条路径上给出不同说法。
 */
export const ACCOUNT_DELETION_PENDING_MESSAGE = '注销申请处理中，暂不能进行该操作，可先撤回申请'

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
