/**
 * Wish Domain 路由常量（Issue #7）。
 *
 * 这些是 **API 侧路径**（根级）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉前缀
 * （`apps/web/vite.config.ts`、`docs/architecture.md` §5.1；生产同源部署行为一致）。
 * 口径与 `listings` / `matching` 的 `routes.ts` 一致。前端 typed client 与 API router
 * 共用本文件，禁止在别处硬编码这些路径。
 *
 * #43 复核：此前这里写的是 `/api/wishes`，等于把**浏览器前缀**写进了 API 路径。后果是
 * 前端按本仓约定拼 `/api` + `/wishes` 会打到 API 的 `/wishes`，而 API 只挂 `/api/wishes`
 * → 404；唯一的绕过写法是直接传常量得到 `/api/api/wishes`，路径语义与另两个域分叉。
 * `packages/contracts/src/wishes/routes.test.ts` 是本条的回归守卫。
 */
export const WISH_ROUTES = {
  base: '/wishes',
  pool: '/wishes/pool',
  detail: (id: string) => `/wishes/${id}`,
  close: (id: string) => `/wishes/${id}/close`,
  fulfill: (id: string) => `/wishes/${id}/fulfill`,
} as const
