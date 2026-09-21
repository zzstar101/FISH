/**
 * 「我的发布」的纯判定（无 Taro、无 mock 依赖：`tests/mylist-list.test.ts` 直接 import）。
 *
 * 最关键的一条：**审核态必须先于 `status` 判断**。
 * `REVIEW` / `BLOCKED` 的商品在库里同样是 `status = OFFLINE`，只按 status 分档会把
 * 「等你改内容」和「你自己下架的」混进同一段，这正是 #74 要修的表现。
 */
import type { ListingModerationStatus, ListingStatus } from '@fish/contracts/listings/schema'

export type MyListSegment = 'sale' | 'reserved' | 'sold' | 'review' | 'off'

/** 分段顺序：交易中/已售出排在审核中之前，与「在售 → 流转 → 异常」的阅读顺序一致。 */
export const SEGMENTS: { key: MyListSegment; label: string }[] = [
  { key: 'sale', label: '在售' },
  { key: 'reserved', label: '已预订' },
  { key: 'sold', label: '已售出' },
  { key: 'review', label: '审核中' },
  { key: 'off', label: '已下架' },
]

type CardLike = {
  status: ListingStatus
  /** 契约只在**卖家本人视角**返回真实值；公开/他人视角恒 null */
  moderationStatus: ListingModerationStatus | null
}

/** 卡片 → 分段。审核态优先：未过审的商品一律进「审核中」，不落进「已下架」。 */
export function segmentOf(card: CardLike): MyListSegment {
  if (card.moderationStatus === 'REVIEW' || card.moderationStatus === 'BLOCKED') return 'review'
  switch (card.status) {
    case 'ACTIVE':
      return 'sale'
    case 'RESERVED':
      return 'reserved'
    case 'SOLD':
      return 'sold'
    default:
      return 'off'
  }
}

export function countBySegment(cards: readonly CardLike[]): Record<MyListSegment, number> {
  const counts: Record<MyListSegment, number> = {
    sale: 0,
    reserved: 0,
    sold: 0,
    review: 0,
    off: 0,
  }
  for (const card of cards) counts[segmentOf(card)] += 1
  return counts
}

/**
 * 能否编辑。
 *
 * `RESERVED` / `SOLD` 被交易锁定（与服务端 `LOCKED_LISTING_STATUSES` 同一口径，违者 409）。
 * 审核中**可以编辑**：服务端允许 PATCH 并会重新审核 —— 用户改掉被拦的内容后商品回到
 * APPROVED（仍是 OFFLINE，需要再手动上架），这是「被拦下之后怎么补救」的唯一路径。
 */
export function isEditable(segment: MyListSegment): boolean {
  return segment !== 'reserved' && segment !== 'sold'
}

/** 状态胶囊文案（`BLOCKED` 与 `REVIEW` 都在「审核中」段，但要说清是哪种）。 */
export function segmentLabel(card: CardLike, segment: MyListSegment): string {
  switch (segment) {
    case 'sale':
      return '在售'
    case 'reserved':
      return '已预订'
    case 'sold':
      return '已售出'
    case 'review':
      return card.moderationStatus === 'BLOCKED' ? '未通过审核' : '审核中'
    default:
      return '已下架'
  }
}

/** 锁定态被点击时的说明（不给编辑入口，但要说清为什么）。 */
export function lockedHint(segment: MyListSegment): string {
  if (segment === 'reserved') return '已预订：成交或取消前不能改价改文案'
  if (segment === 'sold') return '已售出：成交后编辑永久禁用'
  return ''
}

/** 空态文案：审核中段要说明「谁会出现在这里」，而不是复用通用那句。 */
export function emptyText(segment: MyListSegment): string {
  if (segment === 'review') return '待人工复核或未通过审核的商品会出现在这里，可以修改后重新提交'
  if (segment === 'off') return '被下架的商品会出现在这里，可随时重新上架'
  return '换个状态看看，或者发布一件新的闲置'
}
