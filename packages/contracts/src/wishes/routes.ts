/**
 * Wish Domain 路由常量（Issue #7）。
 * 前端 typed client 与 API router 共用，禁止在别处硬编码这些路径。
 *
 * 路径是 **API 侧路径（根级）**、不带 `/api` 前缀：Web 侧写相对路径 `/api` + 常量，由 Vite
 * 代理去掉前缀再转发到 API（docs/architecture.md「API 自身路由保持根级」）。
 *
 * 注意这是**调用方约定**而不是强制：`apps/web/src/lib/api-client.ts` 只做
 * `fetch('/api' + path)` 的拼接、不做任何校验，传进来带前缀的 `/api/wishes` 会静默变成
 * `/api/api/wishes`。原值带 `/api` 前缀时，按约定请求经代理被改写成 `/wishes`，而 API 只服务
 * `/api/wishes` → 404（见 #41 / #42）。
 */
export const WISH_ROUTES = {
  base: '/wishes',
  pool: '/wishes/pool',
  detail: (id: string) => `/wishes/${id}`,
  close: (id: string) => `/wishes/${id}/close`,
  fulfill: (id: string) => `/wishes/${id}/fulfill`,
} as const
