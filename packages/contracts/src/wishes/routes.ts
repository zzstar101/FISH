/**
 * Wish Domain 路由常量（Issue #7）。
 * 前端 typed client 与 API router 共用，禁止在别处硬编码这些路径。
 *
 * 路径保持**根级**、不带 `/api` 前缀：Web 侧一律写 `/api/...`，由 Vite 代理去掉前缀再转发到
 * API（docs/architecture.md「API 自身路由保持根级」；apps/web/src/lib/api-client.ts 同样只接受
 * 不含 `/api` 的路径并自行拼前缀）。原值带 `/api` 前缀时，浏览器请求经代理后被改写成
 * `/wishes`，而 API 只服务 `/api/wishes` → 404（见 #41 / #42）。
 */
export const WISH_ROUTES = {
  base: '/wishes',
  pool: '/wishes/pool',
  detail: (id: string) => `/wishes/${id}`,
  close: (id: string) => `/wishes/${id}/close`,
  fulfill: (id: string) => `/wishes/${id}/fulfill`,
} as const
