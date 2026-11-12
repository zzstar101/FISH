/**
 * 首屏分批挂载的窗口计算（#595）。
 *
 * 首页一次拿到整批 feed（推荐 `limit=50`），但**视图层不需要一上来就挂 50 张卡**：
 * 首屏之外的那些卡、以及它们的封面与头像请求，都是白花的。这里只算「该挂哪一段」，
 * 页面负责在滚动触底时把窗口推大。整批数据始终留在 `items` 里 —— 首页没有翻页入口，
 * 所有结果必须能一路滚到。
 *
 * 抽成纯函数是为了能测：`splitColumns` / `list-state` / `nav-settle` 同一套做法。
 */
import type { MockListing } from '@/mock/types'

/** 首屏先挂多少张**可见**卡（端上测量后再调，见 PR 里的前后对比） */
export const INITIAL_MOUNT_COUNT = 10

/** 每次触底再挂多少张 */
export const MOUNT_BATCH_SIZE = 10

/**
 * 取「前 `target` 张**可见**卡」的前缀。
 *
 * 隐藏卡（本机「不感兴趣」）也按原顺序纳入前缀 —— 它们渲染为 `null`，但**必须占住
 * 奇偶位**，否则后面的卡会重新分列、整屏重挂（见 `onDislikeListing`）。它们只是
 * **不计入可见名额**：若把隐藏卡算进配额，隐藏几张之后首屏实际可见数就不够，
 * 内容矮于视口时页面滚不动、`onReachBottom` 永不触发，剩下的卡再也挂不上来 ——
 * 那是「空白卡死」，比多挂几张贵得多。
 *
 * 顺序原样保留（不排序、不重排），所以两列交错的版式与挂载前一致。
 */
export function mountPrefix(
  items: MockListing[],
  hiddenIds: readonly string[],
  target: number,
): MockListing[] {
  const prefix: MockListing[] = []
  let visible = 0
  for (const item of items) {
    if (visible >= target) break
    prefix.push(item)
    if (!hiddenIds.includes(item.id)) visible += 1
  }
  return prefix
}

/**
 * 触底之后的新窗口大小：只增不减，且**不超过总数**。
 *
 * 已经全挂完时返回原值（`=== count`），页面那边的 `setState` 会因此 bail，
 * 不会在滚到底之后反复触发渲染。最后一跳会截到总数（`10 → 18` 而不是 `20`），
 * 所以「返回 `total`」就是「已全部挂出」的信号。
 */
export function nextMountCount(count: number, total: number): number {
  return count < total ? Math.min(total, count + MOUNT_BATCH_SIZE) : count
}
