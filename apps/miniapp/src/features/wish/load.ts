/**
 * 许愿 / 匹配结果的取数编排（真接口，fail-closed）。
 *
 * 从 `features/fetchers.ts` 抽出来：这里只依赖愿望域 / 匹配域 / 商品详情的 API 与投影，
 * **不**静态 import 会话域（`chat/api`）—— 少一次无关的模块耦合，测试也不必为了顶替
 * 会话域而引入跨文件的 `mock.module`。
 *
 * 两条加载都没有 mock 回退分支：真接口的愿望 id 是 uuid，mock fixture 是 `w-001` 这种，
 * 混在一起只会造出「真实愿望 + 演示命中」的假象；拿不到就 `failed`，由页面显示错误态。
 */
import { isApiError } from '@/lib/request'
import type { MockUser, MockWish, MockWishPoolItem } from '@/mock/types'
import { toMockSeller } from '../listing/adapt'
import { fetchListingDetail } from '../listing/api'
import { reportFailure } from '../load-failure'
import { type MatchView, toWishHit, type WishHit } from '../match/adapt'
import { fetchWishMatches } from '../match/api'
import { toMockWish, toMockWishPoolItem } from './adapt'
import { fetchMyWishes, fetchWish, fetchWishPool } from './api'

/* --------------------------------------------------------------- 愿望 */

/** 许愿页卡片内嵌展示的命中行数（设计稿是 3 条）；页面的 `slice` 与这里的 `limit` 同源 */
export const WISH_HIT_ROWS = 3

/** 一个愿望的命中：`total` 是服务端阈值过滤后的真实条数，`items` 是前 N 条 */
export type WishHitList = { total: number; items: WishHit[] }

export type WishesResult =
  | { status: 'ok'; mine: MockWish[]; pool: MockWishPoolItem[]; hits: Record<string, WishHitList> }
  | { status: 'failed' }

/**
 * 许愿页一次要的三块数据：我的愿望 + 愿望池 + 每条 ACTIVE 愿望的命中。
 *
 * **刻意没有 mock 回退**（与 `loadPublicUserHome` 同一取舍）：真接口的愿望 id 是 uuid，
 * 而 mock fixture 的 id 是 `w-001` 这种，混在一起只会造出「真实愿望 + 演示命中」的假象。
 * 所以开发 / 预览构建拿不到后端时同样返回 `failed`，由页面显示错误态与重试入口。
 *
 * 命中按愿望逐条拉 `/matches?wishId=`（契约没有批量端点）：只有 `ACTIVE` 且
 * `matchCount > 0` 的愿望才会产生请求，上限是 ACTIVE 愿望条数（服务端限制 10 条）。
 * 单条命中失败不拖垮整页 —— 卡片仍有契约给出的 `matchCount`，只是没有命中行。
 */
export async function loadWishes(): Promise<WishesResult> {
  try {
    const [wishes, pool] = await Promise.all([fetchMyWishes(), fetchWishPool()])
    const mine = wishes
      .map((wish) => toMockWish(wish))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const hits = await loadWishHits(
      mine.filter((wish) => wish.status === 'ACTIVE' && wish.matchCount > 0).map((wish) => wish.id),
    )
    return { status: 'ok', mine, pool: pool.map((item) => toMockWishPoolItem(item)), hits }
  } catch (error) {
    reportFailure('愿望列表', error, false)
    return { status: 'failed' }
  }
}

/**
 * 逐条拉命中。`limit` 就是卡片要展示的行数 —— 卡片上「N 件命中」用响应里的 `total`
 * （阈值过滤后的真实条数）、行用 `items`，两者同源，不会出现「说命中 5 件却一条都点不开」。
 */
async function loadWishHits(ids: string[]): Promise<Record<string, WishHitList>> {
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, WishHitList] | null> => {
      try {
        const result = await fetchWishMatches(id, WISH_HIT_ROWS)
        return [id, { total: result.total, items: result.items.map((item) => toWishHit(item, id)) }]
      } catch (error) {
        console.warn(`[miniapp] 愿望命中获取失败（wishId=${id}）`, error)
        return null
      }
    }),
  )
  return Object.fromEntries(
    entries.filter((entry): entry is [string, WishHitList] => entry !== null),
  )
}

/* --------------------------------------------------------------- 匹配结果 */

/**
 * 契约 `MatchListQuerySchema` / `wishes` 路由都按 uuid 校验目标 id。
 * 用于在客户端先挡掉旧 mock 链接（`w-011`）这类非法 id，避免两个端点给出
 * 404 / 422 两种拒绝、页面状态随竞态抖动。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WishMatchResult =
  | {
      status: 'ok'
      wish: MockWish
      /** `/matches` 的 `total`：阈值过滤后的真实条数，可能大于 `items.length`（limit 截断 / 跳过无法映射的卡片） */
      total: number
      items: MatchView[]
    }
  /** 404：愿望不存在（或客户端给了非法 id） */
  | { status: 'notFound' }
  /** 403：愿望不属于当前账号 */
  | { status: 'forbidden' }
  | { status: 'failed' }

/**
 * 匹配结果页：愿望本身 + 它的命中商品（含卖家）。
 *
 * 404 / 403 / 其它三分开：404 是「不存在」，403 是「不是你的愿望」（`FORBIDDEN` /
 * `NOT_TARGET_OWNER`），两者都不该被说成「已成交或已过期」；网络或契约失败是「没问到」，
 * 页面该显示重试。
 *
 * `total` 与 `items.length` 都回传：页面计数用 `total`（契约明确两者不该互相推导，
 * 见 `matching/schema.ts` 的 `WishMatchListResponseSchema`）。
 *
 * 卖家：契约的 `WishMatchItem` 只有 `ListingCard`（无 `sellerId`、无 `seller`），
 * 所以逐条拉 `GET /listings/:id` 取详情里的 seller。补不到就是 `null`，页面不渲染
 * 卖家那一格 —— 不编造卖家。请求数与命中条数同阶（上限 50，通常个位数）。
 */
export async function loadWishMatches(wishId: string): Promise<WishMatchResult> {
  // 契约的 wishId 是 uuid。非法 id 先在客户端挡掉：两个请求并行时，`/wishes/:id` 会返
  // 404（router 先做 uuid 校验）而 `/matches` 的 `z.uuid()` 返 422 —— 谁先 reject 谁决定
  // 页面显示「已结束」还是「加载失败」。挡住之后结果确定，也不发注定失败的请求。
  if (!UUID_PATTERN.test(wishId)) return { status: 'notFound' }
  try {
    const [wish, list] = await Promise.all([fetchWish(wishId), fetchWishMatches(wishId)])
    const hits = list.items.map((item) => toWishHit(item, wishId))
    const sellers = await Promise.all(hits.map((hit) => fetchHitSeller(hit.listing.id)))
    return {
      status: 'ok',
      wish: toMockWish(wish),
      total: list.total,
      items: hits.map((hit, index) => ({ ...hit, seller: sellers[index] ?? null })),
    }
  } catch (error) {
    if (isApiError(error) && error.status === 403) return { status: 'forbidden' }
    if (isApiError(error) && error.status === 404) return { status: 'notFound' }
    reportFailure('匹配结果', error, false)
    return { status: 'failed' }
  }
}

/** 命中商品的卖家：拿不到（网络失败 / 商品已删 / 已下架）就返回 `null`，由页面不渲染。 */
async function fetchHitSeller(listingId: string): Promise<MockUser | null> {
  try {
    const detail = await fetchListingDetail(listingId)
    return detail === null ? null : toMockSeller(detail)
  } catch (error) {
    console.warn(`[miniapp] 命中商品卖家获取失败（listingId=${listingId}）`, error)
    return null
  }
}
