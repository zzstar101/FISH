/**
 * 「收藏」的本机名单（瀑布流卡片长按菜单用）。
 *
 * 收藏在后端**不存在**：`packages/contracts` 没有 favorites 域、`apps/api` 没有 favorites
 * 模块（`packages/db/src/schema/favorites.ts` 只有表、没有对外端点），商品详情页那颗红心至今
 * 也只是本页 `useState`（`pages/listing-detail/view.ts` 的 `faved`）。所以卡片菜单的「收藏」
 * 只做两件事：
 *
 * 1. 把 id 记进本机名单 —— 菜单据此显示「收藏 / 取消收藏」，离开页面再回来仍认这个状态；
 * 2. 发一条 `FAVORITE` / `UNFAVORITE` 事件（在 `components/product-card` 里发）—— 契约里这
 *    两类**只能由客户端上报**（不在 `RECOMMENDATION_SERVER_CONFIRMED_EVENT_TYPES` 里，
 *    见 `docs/design/issue-323-r1-event-tracking.md` §1），是今天唯一能落到服务端的收藏信号，
 *    也是 R2–R6 排序（多路召回 / 兴趣向量 / ranker）的原料。
 *
 * **不假装服务端也收藏了**：没有端点就没有「提交」，这份名单只代表这台设备 —— 与
 * `pages/favorites` 的取向一致（那一页如实说「收藏还没接后端」，而不是给假列表）。
 * **不设 TTL**（对比 `features/recommendation/hidden.ts` 的 180 天）：不喜欢是一次性名单，
 * 过期无所谓；收藏是用户意图，自己过期等于悄悄丢用户的东西。
 */
import Taro from '@tarojs/taro'

/** 存储 key：规格固定值，不要改名 */
const FAVORITES_KEY = 'fish.favorites.localListings'

type StoredFavorites = { ids: string[] }

function readStoredFavorites(): string[] {
  try {
    const raw: unknown = Taro.getStorageSync(FAVORITES_KEY)
    if (typeof raw !== 'object' || raw === null) return []
    const candidate = raw as { ids?: unknown }
    if (!Array.isArray(candidate.ids)) return []
    return candidate.ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function writeStoredFavorites(ids: string[]): boolean {
  const stored: StoredFavorites = { ids }
  try {
    Taro.setStorageSync(FAVORITES_KEY, stored)
    return true
  } catch {
    // 存储失败不致命（配额满 / 存储不可用），但**不能假装写成功了**：调用方要如实提示用户
    return false
  }
}

/** 这件商品在本机被收藏过没有 */
export function isListingFaved(listingId: string): boolean {
  return readStoredFavorites().includes(listingId)
}

/**
 * 收藏 / 取消收藏，返回**落盘后**的真实状态（存储写失败时就是原状态）。
 *
 * 写完**重读核对**再返回（与 `features/recommendation/queue.ts` 同一个口径）：
 * `setStorageSync` 失败是静默的，只按意图返回就会让菜单显示「取消收藏」而存储里根本没有 ——
 * 重新进页面又变回「收藏」，用户白点一次。返回值因此是「这台设备现在认不认」的真值，
 * 卡片据此决定提示文案（见 `components/product-card`）。
 *
 * 已经是目标状态时直接返回、不写存储：重复点同一边不该把存储无谓写一遍。
 */
export function setListingFavorite(listingId: string, faved: boolean): boolean {
  const ids = readStoredFavorites()
  if (ids.includes(listingId) === faved) return faved
  writeStoredFavorites(faved ? [...ids, listingId] : ids.filter((id) => id !== listingId))
  return isListingFaved(listingId)
}
