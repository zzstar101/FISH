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

/**
 * **枚举一律复用契约，不在这里重抄。**
 *
 * `packages/contracts/src/listings/schema.ts` 头部写得很明确：「本目录是商品域协议的
 * 唯一来源：API 与 Web（含 Mock adapter）都从这里 import，**禁止在别处重复定义枚举或值域**」。
 * 重抄一份的代价是两边各自演化，漂移只会在接真接口或 INSERT 时才炸。
 *
 * 为什么是 `import type` 而不是值导入：值导入会把 zod 一起打进小程序产物
 * （实测 vendors.js 8KB → 99KB，见 `src/lib/contracts.ts` 的注释与 `config/index.ts`
 * 里 `mini.compile.include` 的说明）；type-only 不产生任何运行时代码。
 */
import type { AuthStatus, Campus } from '@fish/contracts/auth/user'
import type {
  ConversationListing,
  ConversationRole,
  ConversationUser,
  MessageType,
} from '@fish/contracts/chat/schema'
import type {
  ListingCategory,
  ListingCondition,
  ListingStatus,
} from '@fish/contracts/listings/schema'
import type { NotificationDto } from '@fish/contracts/notifications/schema'
import type { TransactionStatus, TransactionUser } from '@fish/contracts/transactions/schema'
import type { WishStatus } from '@fish/contracts/wishes/schema'

/* ---------------------------------------------------------------- 用户 */

/** 复用 `auth/user.ts` 的 `Campus` / `AuthStatus`（契约是唯一真源） */
export type { AuthStatus, Campus }

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

/** 复用 `listings/schema.ts` 的 `ListingCategory` / `ListingCondition` / `ListingStatus` */
export type { ListingCategory, ListingCondition, ListingStatus }

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

/** 复用 `wishes/schema.ts` 的 `WishStatus` */
export type { WishStatus }

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

/** 复用 `chat/schema.ts` 的 `MessageType` / `ConversationRole` */
export type { ConversationRole, MessageType }

/**
 * 会话里的对方：契约 `ConversationUser`（id / nickname / avatarUrl）
 * **+ mock 专属** `authStatus`——列表行要显示认证徽章，而契约里没有这个字段。
 * 结构上仍可赋给 `ConversationUser`，所以接真接口时只需删掉多出来的这一项。
 */
export type MockConversationCounterpart = ConversationUser & { authStatus: AuthStatus }

export type MockConversation = {
  id: string
  /** 契约 `ConversationDto.role`：我在这条会话里是买家还是卖家 */
  role: ConversationRole
  /**
   * 契约 `ConversationDto.listing`：**服务端组装**好的商品摘要。
   * 页面因此不必再拿 `listingId` 自己去查表（避免「生成的键通不过自己的校验」那类漂移）。
   */
  listing: ConversationListing
  /** 契约 `ConversationDto.counterpart`：会话对面的用户摘要 */
  counterpart: MockConversationCounterpart
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

/** 复用 `transactions/schema.ts` 的 `TransactionStatus` */
export type { TransactionStatus }

/**
 * 交易里的对方：契约 `TransactionUser`（id / nickname / avatarUrl）
 * **+ mock 专属** `authStatus`（订单卡上的认证徽章）。
 */
export type MockTransactionCounterpart = TransactionUser & { authStatus: AuthStatus }

export type MockTransaction = {
  id: string
  /** 契约 `TransactionDto.listingId`；商品摘要由 `OrderView` 组装（同契约的 embedding 口径） */
  listingId: string
  /** 契约 `TransactionDto.role` */
  role: ConversationRole
  /** mock 内部的引用键；契约 DTO 对外给的是组装好的 `counterpart` */
  counterpartId: string
  amountCents: number
  status: TransactionStatus
  createdAt: string
  /**
   * mock 专属：设计稿订单卡上的相对时间。
   *
   * **刻意没有 `conversationId`**：契约的 `TransactionDto` 里没有这个字段，
   * 会话由 (listingId, 对方) 定位（契约保证「同一 (listing, 买家) 只有一个会话」）。
   * 页面的「查看会话」走 `openConversation()`，与 #72 / PR #82 的口径一致。
   */
  timeLabel: string
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

/** 复用 `notifications/schema.ts` 的 `NotificationDto` */
export type { NotificationDto }

/**
 * 通知的**展示视图** = 契约 `NotificationDto` + 前端按 `type` / `payload` 组装出来的文案与目标。
 *
 * 依据 #23：「服务端不存也不返回文案——标题/描述/图标由客户端按 `type`（必要时结合 `payload`
 * 回查商品名）渲染」，所以 `title` / `description` / `target` 都是**客户端产物**，不进契约。
 * 与 web 端 `apps/web/src/lib/mock/store.ts` 的 `decorateNotification` 同一口径。
 *
 * `readAt`（契约字段）是唯一的已读来源：`null` = 未读，不额外造布尔字段。
 */
export type MockNotification = NotificationDto & {
  title: string
  description: string
  /** 跳转目标；`null` = 这条通知没有可跳的地方（只标记已读） */
  target: { kind: 'listing'; listingId: string } | { kind: 'wish'; wishId: string } | null
  /** 视觉语气：命中成功 / 需要留意 */
  tone: 'mint' | 'warn'
}

/* ---------------------------------------------------------------- 搜索 */

export type HotSearchItem = {
  term: string
  /** 热度计数，设计稿右侧的数字 */
  count: number
}

export type SearchFilter = '综合' | '最新' | '价格' | '成色'
