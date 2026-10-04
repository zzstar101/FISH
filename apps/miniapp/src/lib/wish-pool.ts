/**
 * `/wishes/pool` 的 k-匿名门槛：只有 **≥ 3 个不同用户**求同一个关键词，该关键词才会出现在池子里。
 *
 * 真源是 `apps/api/src/modules/wishes/service.ts` 的 `POOL_MIN_COUNT`（契约里没有这个常量，
 * 所以这里镜像一份，只为让页面的说明文案与筛选口径与后端一致）。
 *
 * 放在 `@/lib` 而不是 `@/mock/*`：这是真实口径常量，页面不该为了一个数字静态
 * import 整包 fixture（`mock/wishes.ts` 仍 re-export 保持既有路径可用）。
 */
export const POOL_MIN_COUNT = 3
