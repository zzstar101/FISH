/**
 * 已售 / 已下架商品在列表卡上的**标记文案**（#566）。
 *
 * 单一来源：共享卡片 `components/product-card` 与他人主页的自绘卡都从这里取字面量，
 * #567 的详情页底部栏也复用它 —— 否则「卖掉了」和「已售出」会在两处各自长一遍。
 *
 * 只把 `SOLD` / `OFFLINE` 认成「已出局」：
 * - `ACTIVE` 在售；`RESERVED` 是有人拍下、还没成交，仍属售卖流程，都不该被灰罩盖住；
 * - `OFFLINE` 一值承载四种语义（卖家自下架 / 审核中 `REVIEW` / 不过审 `BLOCKED` / 平台治理下架），
 *   那套细分只在**卖家视角**说得清（`moderationStatus` 只在查自己时非 null，见
 *   `packages/contracts/src/listings/schema.ts` 与 `pkg-browse/pages/mylist/list.ts` 的
 *   `segmentOf`）。列表卡上的角标按更粗的粒度统一说「下架了」。
 */
import type { ListingStatus } from '@fish/contracts/listings/schema'

/** 状态 → 角标文案；仍在售卖流程里的状态不在表里（= 不打标记） */
const OUT_OF_MARKET_LABEL: Partial<Record<ListingStatus, string>> = {
  SOLD: '卖掉了',
  OFFLINE: '下架了',
}

/** 需要打「已出局」标记时返回角标文案，否则 `null`（调用方据此决定灰罩 / 置灰是否生效） */
export function outOfMarketLabel(status: ListingStatus): string | null {
  return OUT_OF_MARKET_LABEL[status] ?? null
}
