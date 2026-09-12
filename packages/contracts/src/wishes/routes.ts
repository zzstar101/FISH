/**
 * Wish Domain 路由常量（Issue #7）。
 * 前端 typed client 与 API router 共用，禁止在别处硬编码这些路径。
 */
export const WISH_ROUTES = {
  base: '/api/wishes',
  pool: '/api/wishes/pool',
  detail: (id: string) => `/api/wishes/${id}`,
  close: (id: string) => `/api/wishes/${id}/close`,
  fulfill: (id: string) => `/api/wishes/${id}/fulfill`,
} as const
