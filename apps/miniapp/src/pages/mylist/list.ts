/**
 * 「我的发布」的纯判定（无 Taro、无 mock 依赖：`tests/mylist-list.test.ts` 直接 import）。
 *
 * 分段只由**商品状态**决定，外加一个由会话侧推导出来的「有买家在等」：
 *
 * - 「待确认」= 有买家在等（`ACTIVE` + 未回应的 `tx.proposal`）**或**已同意待面交（`RESERVED`）。
 *   前者不是商品状态：买家点「我想要」只往会话写一条 SYSTEM 消息，商品仍是 `ACTIVE`
 *   （见 `./pending.ts` 与页头说明），所以这一半事实由调用方从会话侧推导后传进来。
 * - **审核态不参与分档**（Owner 2026-09-24 拍板：**商品全流程里没有「审核中」这个前端状态**）。
 *   Owner 口述的流程：发布 → AI 审核（瞬时出结果，没有进行状态）→ 在售 → 买家点「我想要」→
 *   待确认 → 双方同意 → 待面交 → 线下面交（交易码）→ 已完成 → 「重新上架」回出物页重新发布
 *   （让一件商品可以反复卖）。审核态（`moderationStatus` 的 `REVIEW` / `BLOCKED`）在库里
 *   同样是 `status = OFFLINE`，因此与「自己下架的」一起读作「已下架」，胶囊文案也不区分。
 */
import type { ListingStatus } from '@fish/contracts/listings/schema'

export type MyListSegment = 'sale' | 'pending' | 'sold' | 'off'

/** 分段顺序：交易中/已售出排在已下架之前，与「在售 → 流转 → 异常」的阅读顺序一致。 */
export const SEGMENTS: { key: MyListSegment; label: string }[] = [
  { key: 'sale', label: '在售' },
  { key: 'pending', label: '待确认' },
  { key: 'sold', label: '已售出' },
  { key: 'off', label: '已下架' },
]

type CardLike = {
  id: string
  status: ListingStatus
}

/** 卡片 → 分段。`awaiting` = 这件商品有买家在等（会话侧推导出来的，见 `./pending.ts`）。 */
export function segmentOf(card: CardLike, awaiting: boolean): MyListSegment {
  switch (card.status) {
    case 'ACTIVE':
      return awaiting ? 'pending' : 'sale'
    case 'RESERVED':
      return 'pending'
    case 'SOLD':
      return 'sold'
    default:
      return 'off'
  }
}

/** `awaitingIds` 是「有买家在等」的商品 id 集合（缺省空集 = 只看商品状态分档）。 */
export function countBySegment(
  cards: readonly CardLike[],
  awaitingIds: ReadonlySet<string> = new Set(),
): Record<MyListSegment, number> {
  const counts: Record<MyListSegment, number> = {
    sale: 0,
    pending: 0,
    sold: 0,
    off: 0,
  }
  for (const card of cards) counts[segmentOf(card, awaitingIds.has(card.id))] += 1
  return counts
}

/** 状态胶囊文案 = 分段自己的名字（不再有按审核态细分的第二种说法）。 */
export function segmentLabel(segment: MyListSegment): string {
  return SEGMENTS.find((seg) => seg.key === segment)?.label ?? ''
}

/**
 * **卡片胶囊**文案：多数段与分段同名，只有「待确认」段里那两种子状态要分开说。
 *
 * 「待确认」段装的是两件不同的事（见文件头）：有买家在等你点头（`awaiting`），
 * 以及你已经同意、等面交（`RESERVED`）。后半段的卡片正文本来就写着
 * 「已同意 · 等面交」，胶囊再顶一个「待确认」就是**同一张卡自相矛盾**。
 * 所以这一种子状态按订单页的口径叫「待面交」
 * （`components/order-list` 的 `PENDING_MEETUP` 也叫「待面交」），一个状态一个名字。
 *
 * 分段控件上的名字不变（那一段就叫「待确认」，装的是它两种子状态）。
 */
export function cardLabel(segment: MyListSegment, awaiting: boolean): string {
  if (segment === 'pending' && !awaiting) return '待面交'
  return segmentLabel(segment)
}

/**
 * 行内动作区开头的锁定说明（1版稿 ⑥ 的 `LOCK` 表）。
 *
 * 只有「已售出」有：成交记录本身就是凭据，价与文案都不能再改，这一行摆的是
 * 查看会话 + 再次上架（后者走出物页新建一条，见页头说明）。**「待确认」刻意不挂锁** ——
 * 那一段的「先别改」由「谁在等」那一行与决策按钮表达（稿 ⑥ 的原话），挂个锁图标只会跟旁边的
 * 按钮打架。
 */
export function lockNote(segment: MyListSegment): string {
  return segment === 'sold' ? '已成交锁定 · 不可改' : ''
}

/** 空态标题：每一段说清「这里会出现什么」，不复用同一句。 */
export function emptyTitle(segment: MyListSegment): string {
  switch (segment) {
    case 'sale':
      return '还没有在售的商品'
    case 'pending':
      return '还没有待确认的申请'
    case 'sold':
      return '还没有卖出的商品'
    default:
      return '这个状态下还没有东西'
  }
}

/** 空态说明（1版稿 `EMPTY` 表）。 */
export function emptyText(segment: MyListSegment): string {
  switch (segment) {
    case 'sale':
      return '发布一件闲置，它就会出现在这里'
    case 'pending':
      return '买家点「我想要」之后，会停在这里等你确认'
    case 'sold':
      return '完成面交的商品会归档到这里'
    default:
      return '被下架的商品会出现在这里，可随时重新上架'
  }
}
