/**
 * Mock 数据类型：字段与 `packages/contracts` 的冻结契约一一对应。
 *
 * 这些是**投影**而不是自造结构：金额一律整数分（`*Cents`），枚举大小写与契约一致
 * （`DIGITAL` / `LIKE_NEW` / `ACTIVE` / `PENDING_MEETUP` …），这样将来把 mock/api.ts
 * 换成真实 fetch 时，页面的数据形状不需要改。
 *
 * 与契约的刻意差异（都已在上游记录）：
 * - `ListingDetail` 多一个 `views` / `wants`：设计稿详情页要显示「218 浏览 · 34 想要」，
 *   而契约里没有这两个计数（上游无此字段）。属于 mock 才有的展示数据。
 * - `Comment` 在本仓契约里根本不存在（`packages/contracts/src` 没有 comments），
 *   详情页留言区因此只能 mock——这里显式标注，不假装它有契约。
 */

/* ---------------------------------------------------------------- 用户 */

/** 对应 `auth/user.ts` 的 `Campus` */
export type Campus = '肇庆' | '广州'

/** 对应 `auth/user.ts` 的 `AuthStatus` */
export type AuthStatus = 'UNVERIFIED' | 'VERIFIED'

export type MockUser = {
  id: string
  nickname: string
  avatarUrl: string
  campus: Campus
  authStatus: AuthStatus
  /** mock 专属：设计稿详情页要展示「卖出 9 件 · 好评率 100%」 */
  soldCount: number
  goodRate: number
}

/* ---------------------------------------------------------------- 商品 */

/** 对应 `listings/schema.ts` 的 `ListingCategory` */
export type ListingCategory =
  | 'DIGITAL'
  | 'BOOKS'
  | 'BEAUTY'
  | 'DAILY'
  | 'SPORTS'
  | 'APPAREL'
  | 'TRANSPORT'
  | 'OTHER'

/** 对应 `listings/schema.ts` 的 `ListingCondition` */
export type ListingCondition = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR'

/** 对应 `listings/schema.ts` 的 `ListingStatus` */
export type ListingStatus = 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE'

/** 图片比例：设计稿的瀑布流是手工错落的，比例随商品走 */
export type ImageRatio = '1x1' | '4x5' | '5x6' | '3x4' | '4x3'

export type MockListing = {
  id: string
  title: string
  /** 整数分 */
  priceCents: number
  /** mock 专属：设计稿商品卡上的划线原价 */
  originalPriceCents: number | null
  category: ListingCategory
  condition: ListingCondition
  status: ListingStatus
  urgent: boolean
  negotiable: boolean
  free: boolean
  /** 封面图（本地资源路径）；契约里可为 null，这里全部有图 */
  coverUrl: string
  /** 详情轮播，1~9 张 */
  images: string[]
  ratio: ImageRatio
  /** mock 专属：商品卡左上角角标文案（同栋 / 急出 / 全新 / 同校 …） */
  badge: string | null
  description: string
  /** 规格行，如「白色 · 三模蓝牙 · 全键盘布局」 */
  spec: string
  sellerId: string
  /** mock 专属：浏览量 / 想要数（契约无此字段） */
  views: number
  wants: number
  /** 距今天数，用于「2 小时前发布」这类相对时间 */
  createdHoursAgo: number
  createdAt: string
}

/* ---------------------------------------------------------------- 留言（无契约） */

/** 契约里没有 comments 域，详情页留言区是纯 mock 展示数据。 */
export type MockComment = {
  id: string
  listingId: string
  authorName: string
  authorInitial: string
  /** 卖家本人回复才显示「卖家」标签 */
  isSeller: boolean
  content: string
  timeLabel: string
}

/* ---------------------------------------------------------------- 愿望 */

/** 对应 `wishes/schema.ts` 的 `WishStatus` */
export type WishStatus = 'ACTIVE' | 'CLOSED' | 'FULFILLED'

/** 对应 `wishes/schema.ts` 的 `WishDto` */
export type MockWish = {
  id: string
  userId: string
  keyword: string
  category: ListingCategory
  budgetMinCents: number
  budgetMaxCents: number
  description: string | null
  acceptSimilar: boolean
  status: WishStatus
  matchCount: number
  createdAt: string
  /** mock 专属：列表行上的位置与相对时间 */
  campus: Campus
  timeLabel: string
}

/** 对应 `wishes/schema.ts` 的 `WishPoolItem` */
export type MockWishPoolItem = {
  keyword: string
  category: ListingCategory
  wantCount: number
  medianBudgetCents: number
}

/** 对应 `matching` 域语义（我许的愿 ↔ 匹配到的商品） */
export type MockMatch = {
  id: string
  wishId: string
  listingId: string
  /** 0~100 */
  score: number
}

/* ---------------------------------------------------------------- 聊天 */

/** 对应 `chat/schema.ts` 的 `MessageType` */
export type MessageType = 'TEXT' | 'SYSTEM'

/** 对应 `chat/schema.ts` 的 `ConversationRole` */
export type ConversationRole = 'buyer' | 'seller'

export type MockConversation = {
  id: string
  listingId: string
  role: ConversationRole
  counterpartId: string
  unreadCount: number
  lastMessage: {
    type: MessageType
    content: string
    senderId: string | null
    createdAt: string
  } | null
  lastMessageAt: string
  /** mock 专属：设计稿筛选胶囊用 */
  kind: 'deal' | 'wish' | 'system'
  /** mock 专属：设计稿列表上的时间文案 */
  timeLabel: string
  /** mock 专属：交易状态标签（交易 / 已完成 / 许愿 / 系统） */
  tag: string
  tagDone: boolean
  /** mock 专属：对方是否在线（绿点） */
  online: boolean
}

export type MockMessage = {
  id: string
  conversationId: string
  senderId: string | null
  type: MessageType
  content: string
  createdAt: string
}

/* ---------------------------------------------------------------- 交易 */

export type TransactionStatus = 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'

export type MockTransaction = {
  id: string
  listingId: string
  role: ConversationRole
  counterpartId: string
  amountCents: number
  status: TransactionStatus
  createdAt: string
}

/* ---------------------------------------------------------------- 通知 */

export type MockNotification = {
  id: string
  /** `payload` 决定跳转目标，与 `notifications` 契约的语义一致 */
  kind: 'wish_match' | 'listing_comment' | 'transaction' | 'system'
  title: string
  body: string
  listingId: string | null
  wishId: string | null
  read: boolean
  createdAt: string
}

/* ---------------------------------------------------------------- 搜索 */

export type HotSearchItem = {
  term: string
  /** 热度计数，设计稿右侧的数字 */
  count: number
}

export type SearchFilter = '综合' | '最新' | '价格' | '成色'
