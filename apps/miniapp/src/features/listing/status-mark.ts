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

/*
 * 已知的第二套措辞（**不合并**，见 PR #575 的待确认清单）：
 * `pkg-browse/pages/history/records.ts:147-151` 的 `goneLabelOf(status)` 判定集合与返回形态
 * 与本文件完全相同，文案却是「已卖掉 / 已下架」；收藏页（`pkg-browse/pages/favorites/list.ts`）
 * 与浏览历史页的角标**必须彼此一致**（稿决策⑥，见 `records.ts:144-146` 的决策记录）。
 *
 * 合并它等于要改收藏 / 历史两页的既有文案，属于另一条票的口径；而本票要求的是
 * 「卖掉了 / 下架了」。两套文案最终统一到哪一套，待 Owner 拍板。
 */

/**
 * 详情页底部栏的**买家**状态行（#567）。
 *
 * 与上面的卡片角标是同一件事的第二种粒度，字面量都归本文件，页面不另写一份：
 * 卡片上空间小，说「卖掉了」；详情页底部栏是整条状态行，说完整一句「此商品已售出」。
 *
 * 只有 `SOLD`：`OFFLINE` 在买家视角**不可达** —— 非卖家读已下架商品的详情一律 404
 * （`apps/api/src/modules/listings/service.ts` 的非卖家 OFFLINE 口径，服务端刻意不泄露
 * 存在性），买家根本到不了这一页，给那格写文案就是死代码。`RESERVED` 仍在售卖流程里
 * （有人拍下、还没成交），底部栏维持正常操作。
 *
 * 卖家视角的措辞不在这里：那是 `pkg-browse/pages/listing-detail/view.ts` 的
 * `ownerStatusNote`，同一个状态的卖家说法是「商品已售出」+ 一条去我的发布管理的出路。
 */
export function buyerStatusNote(status: ListingStatus): string | null {
  return status === 'SOLD' ? '此商品已售出' : null
}
