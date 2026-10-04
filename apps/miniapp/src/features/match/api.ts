/**
 * 匹配域 API（愿望 ↔ 命中商品）。
 *
 * 整条 `/matches` 挂在 `requireAuth` 之下，且只允许看**自己的**愿望 / 商品的匹配
 * （服务端做归属校验，非本人 403、目标不存在 404）。
 */
import { MATCHING_ROUTES } from '@fish/contracts/matching/routes'
import {
  type ListingMatchListResponse,
  ListingMatchListResponseSchema,
  type WishMatchItem,
  WishMatchListResponseSchema,
} from '@fish/contracts/matching/schema'
import { apiRequest } from '@/lib/request'

/** 契约 `MatchListQuerySchema` 的 `limit` 上限是 50。 */
const MATCH_LIMIT_MAX = 50

/**
 * 我的某个愿望的匹配列表（服务端按 `score` 倒序）。
 *
 * `wishId` / `limit` 走 `apiRequest` 的 `query`（由它统一 `encodeURIComponent` 并拼串）。
 * 不要手写 `` `${MATCHING_ROUTES.byWish(id)}&limit=` ``：那样不转义，而且 `byWish`
 * 已经带了 `?`，再叠一次 query 会拼出两个 `?`。
 *
 * 服务端在 `where` 里已经按 `score >= MATCH_SCORE_THRESHOLD` 过滤过
 * （`apps/api/src/modules/matching/store.ts`），客户端不再按阈值二次过滤 —— 否则
 * 前端与后端的「什么是有效匹配」会变成两个数。
 */
export async function fetchWishMatches(
  wishId: string,
  limit: number = MATCH_LIMIT_MAX,
): Promise<{ total: number; items: WishMatchItem[] }> {
  const payload = await apiRequest(MATCHING_ROUTES.base, { query: { wishId, limit } })
  const parsed = WishMatchListResponseSchema.parse(payload)
  // `total` 是库里阈值过滤后的真实条数；映射失败的卡片会被服务端跳过，两者可能不等
  // （契约明确前端不该互相推导），这里原样交给调用方。
  return { total: parsed.total, items: parsed.items }
}

/**
 * 我的某件商品的匹配列表（「谁在求购」，服务端按 `score` 倒序）。
 *
 * 与 `fetchWishMatches` 同一套口径：`listingId` / `limit` 走 `apiRequest` 的 `query`
 * （统一转义与拼串，不要手写 `?` / `&`），服务端校验归属，非本人 403 `NOT_TARGET_OWNER`。
 *
 * ⚠️ 返回的 `total` 是**阈值过滤后的全量条数**，与 `items.length` 不是一回事
 * （`apps/api/src/modules/matching/service.ts` 明写前端不该互相推导）—— 页面要么只用
 * `items`，要么把「共 N 位 / 显示前 M 位」如实说清。
 */
export async function fetchListingMatches(
  listingId: string,
  limit: number = MATCH_LIMIT_MAX,
): Promise<ListingMatchListResponse> {
  const payload = await apiRequest(MATCHING_ROUTES.base, { query: { listingId, limit } })
  return ListingMatchListResponseSchema.parse(payload)
}
