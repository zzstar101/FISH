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
  /** 二级分类名（C1 分类页横滑胶囊）；空串表示未归类 */
  sub: string
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
  /**
   * mock 专属：最后一条是媒体消息时的列表文案（如 `[图片]` / `[语音] 12"`）。
   *
   * 为什么单独一个字段而不是覆盖 `lastMessage`：契约的 `lastMessage.type` 只有
   * `TEXT | SYSTEM`，把媒体塞进去会让类型说谎。真实实现里后端扩 `MessageType`
   * 之后这个字段消失，列表直接读 `lastMessage`。
   */
  mediaPreview: string | null
}

export type MockMessage = {
  id: string
  conversationId: string
  senderId: string | null
  type: MessageType
  content: string
  createdAt: string
}

/** 媒体消息种类（D2 会话页新增） */
export type MediaKind = 'IMAGE' | 'VOICE'

/**
 * 媒体消息（D2 会话页）。
 *
 * **与契约的边界**：`chat/schema.ts` 的 `MessageType` 只有 `TEXT | SYSTEM`，
 * 没有图片/语音（PR #79 被 CHANGES_REQUESTED，`BLOCKED #67`）。所以媒体消息
 * **不能**塞进 `MockMessage` 假装有契约——它是独立的展示扩展，接真实后端时
 * 整块替换（届时 messageType 会加上 IMAGE / VOICE 并带 `mediaUrl` / `durationSec`）。
 *
 * `state` 把「上传中 / 已发送 / 上传失败」也建模进来：真实实现里它是本地乐观
 * 状态的投影，不是服务端返回的字段。
 */
export type MockMediaMessage = {
  id: string
  conversationId: string
  senderId: string
  kind: MediaKind
  /** 图片本地资源；语音没有封面，为 null */
  imageUrl: string | null
  /** 语音时长（秒），图片为 0 */
  durationSec: number
  createdAt: string
  state: 'DONE' | 'UPLOADING' | 'FAILED'
  /** 上传进度 0~100（仅 UPLOADING 有意义） */
  progress: number
}

/** 会话流里的一行：文本 / SYSTEM / 媒体（页面按时间合并后渲染） */
export type ConversationEntry =
  | { kind: 'message'; message: MockMessage }
  | { kind: 'media'; media: MockMediaMessage }

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
  /** mock 专属：设计稿订单卡上的相对时间与「我是买家 / 我是卖家」 */
  timeLabel: string
  /** mock 专属：订单卡「查看会话」要跳进**这一笔**的会话，而不是同商品的其他买家会话 */
  conversationId: string
}

/**
 * 交易码（A2 transaction-meetup）。
 *
 * 与契约的边界：真实实现里交易码是**短期一次性 token**，由后端签发，
 * 不能拿 `transactionId` 当凭证展示。这里为了静态演示固定 6 位码，
 * 并把「过期 / 码错误 / 已完成 / 非参与者」四种异常态都显式建模。
 */
export type MeetupCodeState = 'ACTIVE' | 'EXPIRED' | 'COMPLETED' | 'NOT_PARTICIPANT'

export type MockMeetupCode = {
  /** 6 位数字码，等宽大字号展示 */
  code: string
  state: MeetupCodeState
  /** 距过期秒数（仅 ACTIVE 有意义），渲染成「还剩 4:32」 */
  expiresInSec: number
}

/* ------------------------------------------------------ 想要的人（C5，无契约） */

/** 契约没有「谁想要我的商品」端点（P1），C5 是纯 mock 展示数据。 */
export type MockWatcher = {
  id: string
  listingId: string
  /** 已注销账号：只显示「已注销用户 · 不可联系」，不展示昵称/头像/院系 */
  deactivated: boolean
  nickname: string
  avatarUrl: string
  /** 院系（C5 行上的「计算机学院」）；不公开时为 null */
  department: string | null
  /** 未填预算时为 null（稿子显示「未填预算」，并且不计入中位数） */
  budgetCents: number | null
  authStatus: AuthStatus
  /** 已聊条数：>0 时把动作换成「继续聊」 */
  chattedCount: number
  timeLabel: string
}

/* ---------------------------------------------------- 他人主页（C2，无契约） */

/** 契约无公开资料端点（P1），C2 的统计与在售列表都是 mock。 */
export type MockUserProfile = {
  user: MockUser
  /** 加入天数 */
  joinedDays: number
  activeCount: number
  listedCount: number
  /** 好评率（0~100 整数） */
  goodRate: number
  /** 已关注过 → 关注按钮第三态 */
  following: boolean
  /** 对方不公开校区 */
  hiddenCampus: boolean
}

/* ---------------------------------------------------- 我的发布（C4） */

export type MyListingStatusKey = 'sale' | 'reserved' | 'sold' | 'off'

export type MockMyListing = {
  listing: MockListing
  /** RESERVED / SOLD 锁定编辑（设计稿第 02 帧的禁用态） */
  editable: boolean
  statusLabel: string
  statusKey: MyListingStatusKey
  /** 想要这件事的人数 */
  wants: number
}

/* -------------------------------------------------------- 认证（B3） */

export type VerifyState = 'UNVERIFIED' | 'CODE_SENT' | 'VERIFIED'

export type MockVerify = {
  state: VerifyState
  email: string | null
  verifiedAt: string | null
}

/* -------------------------------------------------------- 设置（B4） */

export type ThemeMode = 'system' | 'light' | 'dark'

export type MockSettings = {
  theme: ThemeMode
  notifyChat: boolean
  notifyWish: boolean
  notifyDeal: boolean
  notifyNews: boolean
  commentPolicy: '已认证用户' | '所有人' | '仅好友'
  publicCampus: boolean
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
