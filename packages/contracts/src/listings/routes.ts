/**
 * Listing Domain 路由常量（Issue #6）。
 *
 * 这些是 **API 侧路径**（根级）。Web 侧写相对路径 `/api` + 常量，由 Vite 代理去掉前缀
 * （`apps/web/vite.config.ts:11-12`、`docs/architecture.md` §5.1）；生产同源部署行为一致。
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 */
export const LISTING_ROUTES = {
  base: '/listings',
  detail: (id: string) => `/listings/${id}`,
  byNumber: (listingNo: string) => `/listings/by-number/${listingNo}`,
  /** 下架：ACTIVE → OFFLINE；对已 OFFLINE 幂等。 */
  offline: (id: string) => `/listings/${id}/offline`,
  /** 重新上架：OFFLINE → ACTIVE；对已 ACTIVE 幂等。 */
  online: (id: string) => `/listings/${id}/online`,
} as const

export const UPLOAD_ROUTES = {
  /** 单张 presign：前端对 1–9 张图逐张调用，每张独立进度与重试。 */
  presign: '/uploads/presign',
  /** 确认对象已上传（对对象存储发 HEAD），无状态、不新增表。 */
  confirm: '/uploads/confirm',
} as const
