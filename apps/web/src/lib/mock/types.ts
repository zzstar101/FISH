import type { Tone } from '@fish/ui/thumb'

/**
 * Mock 领域的类型定义。
 *
 * 这些形状**不进入 `packages/contracts`**：它们只描述「页面需要什么」，
 * 是 #13 接真实 API 之前的前端内部约定（契约冻结后再逐个替换）。
 */

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
  /** `2023-09` 形式，个人页展示「入学年份」 */
  joinedAt: string
  credit: number
  verified: boolean
  /** #5 详情页卖家卡展示「成交 N 笔」。 */
  soldCount: number
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
  /** #6 发布时勾的「急出」：卡片左上角角标 + 详情标签，同时进 `tags` 供搜索命中。 */
  urgent?: boolean
  /** #6 发布时勾的「可刀」：进 `tags`，列表里作为标签展示。 */
  negotiable?: boolean
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

/**
 * #8 匹配结果：一件商品 ↔ 想买它的同学。
 *
 * `score` 是 0–100 的匹配度，按 #8 约定的 MVP 公式推导
 * （类目 0.35 / 关键词 0.35 / 价格 0.30），**阈值 70**：低于阈值不算命中。
 * `reason` 是命中的依据，简化成一句话直接展示（#8 工作项：「匹配评分/原因展示」）。
 */
export type MatchResult = {
  /** 想买这件商品的同学（愿望所有者）。 */
  userId: string
  /**
   * 命中的是这位同学的**哪一条**愿望。
   *
   * 必须带上：同一个同学可能同时挂着几条愿望（如「想要 iPad」和「想要考研数学」），
   * 只按 userId 归集会把两条愿望的命中互相串到一起，同一个商品在两条愿望里都冒出来。
   * 这也是 #23 通知 payload 里 `{ matchId, listingId, wishId }` 的那个 wishId。
   */
  wishId: string
  score: number
  reason: string
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

/**
 * #23 通知。
 *
 * 服务端**只存 `type` + `payload`，不存文案**（`packages/db/src/schema/notifications.ts`
 * 的注释就是这个约定）：文案由客户端按 `type` 组装，改文案不用动数据。
 *
 * P0 只有 `MATCH`（#8 的匹配引擎在「愿望 ↔ 商品」首次命中时写入，收件人是愿望所有者）；
 * `SYSTEM` 是种子里的公告类通知，没有匹配对象。
 */
export type NotificationType = 'MATCH' | 'SYSTEM'

export type Notification = {
  id: string
  type: NotificationType
  /**
   * `MATCH` 的形状是 `{ matchId, listingId, wishId }`。
   * 两个 id 都可能指向**已被删除**的对象，跳转前要各自确认，确认不了就退回列表。
   */
  payload: { matchId?: string; listingId?: string; wishId?: string }
  minutesAgo: number
  read: boolean
}

/** 客户端按 `type` + `payload` 组装出来的可渲染文案（组装在 store 的 adapter 里）。 */
export type NotificationView = Notification & {
  title: string
  description: string
  emoji: string
  tone: Tone
  /** 点这条通知该去哪；为 `null` 表示没有可跳转目标（只标记已读）。 */
  target: { to: '/detail/$listingId'; listingId: string } | { to: '/wish' } | null
}

export type CategoryEntry = {
  id: string
  label: string
  /** 分类圆底插画（`public/categories/*.png`）：首页快捷入口与分类页横滑条都用它。 */
  image: string
  emoji: string
  children: { id: string; label: string; emoji: string }[]
}
