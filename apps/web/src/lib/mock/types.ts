import type { Tone } from '@fish/ui/thumb'

/**
 * Mock 领域的类型定义。
 *
 * 这些形状**不进入 `packages/contracts`**：它们只描述「页面需要什么」，
 * 是 #13 接真实 API 之前的前端内部约定（契约冻结后再逐个替换）。
 */

export type Campus = '东校区' | '西校区' | '南校区' | '北校区'

export type TradeMethod = '校内自提' | '校内面交'

export type ListingCategory =
  | '数码电子'
  | '图书教材'
  | '生活用品'
  | '服饰鞋包'
  | '运动健身'
  | '代步工具'
  | '美妆个护'
  | '其他闲置'

export type User = {
  id: string
  nickname: string
  emoji: string
  tone: Tone
  college: string
  campus: Campus
  /** `2023-09` 形式，个人页展示「入学年份」 */
  joinedAt: string
  credit: number
  verified: boolean
  bio?: string
}

/** #5 要求四种状态都能演示：在售 / 已预定 / 已售出 / 已下架。 */
export type ListingStatus = 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE'

/** 商品；`kind === 'wish'` 表示这是一条「求购」而不是出售。 */
export type Listing = {
  id: string
  title: string
  priceCents: number
  originalPriceCents?: number
  emoji: string
  tone: Tone
  category: ListingCategory
  condition: string
  campus: Campus
  tradeMethod: TradeMethod
  tags: string[]
  description: string[]
  /** 相对当前时间的分钟数，展示时再格式化（截图里全是「10分钟前」这类相对时间） */
  publishedMinutesAgo: number
  views: number
  wantCount: number
  status: ListingStatus
  sellerId: string
  kind: 'listing' | 'wish'
  free?: boolean
}

export type Comment = {
  id: string
  userId: string
  text: string
  minutesAgo: number
}

export type Conversation = {
  id: string
  /** `sys` 表示校园小助手这类官方会话 */
  kind: 'peer' | 'system'
  title: string
  userId?: string
  listingId?: string
  unread: number
  updatedMinutesAgo: number
  messages: Message[]
}

export type Message = {
  id: string
  /** `me` 表示当前登录用户 */
  from: 'me' | 'peer'
  text: string
  /** 分钟数；同一天的相对时间，展示为 HH:mm */
  sentAtMinutesAgo: number
  kind: 'TEXT' | 'SYSTEM'
}

export type Wish = {
  id: string
  userId: string
  keyword: string
  budgetCents: number
  minutesAgo: number
  helpers: number
  matchedCount: number
  mine: boolean
}

/** #11 的交易状态机：请求 → 接受/拒绝 → 待面交 → 完成；买家可取消。 */
export type OrderStatus = 'REQUESTED' | 'PENDING_MEETUP' | 'COMPLETED' | 'REJECTED' | 'CANCELLED'

export type Order = {
  id: string
  role: 'buy' | 'sell'
  listingId: string
  counterpartId: string
  status: OrderStatus
  minutesAgo: number
}

export type NotificationEntry = {
  id: string
  title: string
  description: string
  emoji: string
  tone: Tone
  /** 点进去落在哪个会话（通知区不自己拼 id）。 */
  conversationId: string
}

export type CategoryEntry = {
  id: string
  label: string
  emoji: string
  children: { id: string; label: string; emoji: string }[]
}
