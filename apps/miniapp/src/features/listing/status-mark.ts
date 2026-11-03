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
 * 详情页底部栏的状态行文案（#567）：**两套口吻，同一个模块**。
 *
 * 卖家看自己的商品说「商品已售出」，买家看别人的说「此商品已售出」—— 这是人称 / 语境的
 * 区分，不是漂移；但两份字面量必须待在同一处导出，否则它们迟早各自漂走
 * （Issue #567 修复方向第 4 条：「提到共享常量…避免两个版本漂移」）。
 *
 * - 卖家侧 `SELLER_SOLD_NOTE`：由 `pkg-browse/pages/listing-detail/view.ts` 的
 *   `ownerStatusNote` 引用。卖家其余的措辞（已下架四细分 / 等面交）留在 view.ts —— 那些
 *   只在卖家本人视角成立，与这里的「出局标记」不是同一件事。
 * - 买家侧 `BUYER_SOLD_NOTE` / `buyerStatusNote()`：详情页底部栏用它。卡片角标另有一套
 *   更短的「卖掉了」（`outOfMarketLabel`）：列表空间小，说得短。
 *
 * PC 站（`apps/web-pc`）跨端不能 import 小程序模块，那边照抄同一句，
 * 由 `apps/miniapp/tests/listing-detail-owner-bar.test.ts` 的跨端一致性用例逐字比对。
 */
export const SELLER_SOLD_NOTE = '商品已售出'
export const BUYER_SOLD_NOTE = '此商品已售出'

/**
 * 买家侧：`SOLD` 时底部栏说一句结论，其余 `null`（照常渲染操作钮）。
 *
 * 只有 `SOLD`：`OFFLINE` 在买家视角**不可达** —— 非卖家读已下架商品的详情一律 404
 * （`apps/api/src/modules/listings/service.ts` 的非卖家 OFFLINE 口径，服务端刻意不泄露
 * 存在性），买家根本到不了这一页，给那格写文案就是死代码。`RESERVED` 仍在售卖流程里
 * （有人拍下、还没成交），底部栏维持正常操作。
 */
export function buyerStatusNote(status: ListingStatus): string | null {
  return status === 'SOLD' ? BUYER_SOLD_NOTE : null
}
