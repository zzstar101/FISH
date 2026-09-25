/**
 * 「从我的发布进出物页」的一次性交接位。
 *
 * 为什么需要它：**出物页是 Tab 页**，而小程序禁止 `navigateTo` / `redirectTo` 到 tabBar 页，
 * `switchTab` 又不接受 query（`docs` 与实测都如此）。所以交接目标不能走 URL，只能走
 * 一次性的模块级交接：
 *
 * ```
 * 我的发布页：requestSellEdit(id) / requestSellPrefill(draft) → Taro.switchTab('/pages/sell/index')
 * 出物页：    useDidShow 里 takeSellHandoff() → 取到就进对应模式
 * ```
 *
 * 两种模式的区别：
 *
 * - `edit`：**改这一条**（`PATCH /listings/:id`，图片只读）；
 * - `prefill`：「已售出」的**再次上架**与「已下架」的**重新上架**共用 —— 契约只有
 *   `POST /listings/:id/online`（`OFFLINE → ACTIVE`，同一条回来），没有「照一条成交 / 下架记录
 *   另起一条在售」的端点，所以这两口子都只能**新发布一条**：
 *   把原商品的文案字段带过去，图片必须重选（详情响应刻意不给 `objectKey`，存储布局不进读协议）。
 *
 * **取一次就失效**（`takeSellHandoff` 立即清空）是刻意的：否则用户之后再从底栏点「出物」
 * 会莫名其妙又进上一次的模式，把「新建」和「改某一件 / 复制某一件」搅在一起。
 * 出物页对「这次是新建但没有待取目标」的处理见 `pages/sell/index.tsx` 的 `syncEditTarget`。
 */
import type { ListingCategory, ListingCondition } from '@fish/contracts/listings/schema'

/** 新发布时可带入的商品字段（不含图片：`objectKey` 不在读协议里，预填不了）。 */
export type SellDraft = {
  title: string
  description: string
  priceCents: number
  category: ListingCategory
  condition: ListingCondition
  urgent: boolean
  negotiable: boolean
  free: boolean
}

export type SellHandoff =
  | { kind: 'edit'; listingId: string }
  | { kind: 'prefill'; draft: SellDraft }

let pending: SellHandoff | null = null

/** 我的发布页调用：请求出物页进入这条商品的编辑态 */
export function requestSellEdit(listingId: string): void {
  pending = { kind: 'edit', listingId }
}

/** 我的发布页调用（已售出的「再次上架」/ 已下架的「重新上架」）：请求出物页带着这些字段进新建态 */
export function requestSellPrefill(draft: SellDraft): void {
  pending = { kind: 'prefill', draft }
}

/** 出物页调用：取走并清空待取交接；没有则返回 `null` */
export function takeSellHandoff(): SellHandoff | null {
  const handoff = pending
  pending = null
  return handoff
}
