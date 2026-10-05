import { ApiError } from '../../lib/api-client'

/**
 * 愿望详情「读不到」的判据：**403 与 404 都算不可见**。
 *
 * 服务端是 owner-scoped 的（`apps/api/src/modules/wishes/service.ts` 的 `getWish`）：
 * - 愿望不存在 → 404 `NOT_FOUND`；
 * - 愿望存在但**不是本人的** → 403 `FORBIDDEN`（消息「无权查看该愿望」）。
 *
 * 对当前访客来说两者是同一件事（这不是他能看的愿望），页面统一渲染
 * 「愿望不存在或不可见」，不给「重试」入口 —— 403 重试必然再得一次 403。
 */
export function isWishUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}
