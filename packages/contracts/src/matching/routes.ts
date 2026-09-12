/**
 * Matching Domain 路由常量（Issue #8）。
 *
 * 这些是 **API 侧路径**（根级）：Web 侧写 `/api` + 常量，由 Vite 代理去掉前缀
 * （`apps/web/vite.config.ts:11-17`），与 #6 契约 §0.1 一致。
 * 前端 typed client 与 API router 共用本文件，禁止在别处硬编码这些路径。
 */
export const MATCHING_ROUTES = {
  base: '/matches',
  /**
   * 愿望详情页：我的愿望的匹配列表。
   * 附加 `&limit=` 由调用方自己拼（两个过滤参数互斥，写一个 builder 反而要处理可选参数拼接）。
   */
  byWish: (wishId: string) => `/matches?wishId=${wishId}`,
  /** 商品详情页：我的商品的匹配列表（谁在求购）。 */
  byListing: (listingId: string) => `/matches?listingId=${listingId}`,
} as const
