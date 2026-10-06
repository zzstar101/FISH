/**
 * Mock 数据访问层（唯一入口）。
 *
 * 页面只允许从这里取数据；将来接真实 API 时，改这一个文件即可，页面不动。
 * 所有函数返回 Promise（真实接口也是异步），并带一点延迟让加载态在演示中可见。
 *
 * 与真实契约的边界：商品/愿望/会话/消息/通知的字段都对齐 `packages/contracts`；
 * 留言（comments）在契约里不存在，是本文件内的纯展示 mock（`discover.ts` 有标注）。
 */

import { MATCH_SCORE_THRESHOLD } from '@fish/contracts/matching/schema'
import type { NotificationDto } from '@fish/contracts/notifications/schema'
// 通知文案组装已挪到 `@/features/notifications/decorate`（生产模块，零 fixture 依赖）：
// 真实接口的成功路径也要用它，留在本文件会把整包 fixture 静态拖进生产包。
import { decorateNotifications as decorateNotificationsWith } from '@/features/notifications/decorate'
// 纯展示文案（分类/成色）已挪到 `@/lib/listing-labels`，金额格式化已挪到 `@/lib/money`：
// 真实页面不该为了几张映射表 / 一个纯函数静态 import 整包 fixture。这里 re-export，
// 既有 `@/mock/api` 的 import 路径不受影响。
import {
  CATEGORY_LABEL,
  categoryLabel,
  conditionLabel,
  HOME_CATEGORIES,
  WISH_CATEGORIES,
} from '@/lib/listing-labels'
import { formatAmount, formatYuan } from '@/lib/money'
import {
  APP_BUILD,
  APP_VERSION,
  isEduEmail,
  meetupCodeOf,
  rotateMeetupCode,
  SETTINGS,
  TRANSACTION_BY_ID,
  TRANSACTIONS,
  transactionsOf,
  userProfile,
  VERIFY,
  WATCHER_LISTING_ID,
  WATCHERS,
  watcherCount,
  watcherStats,
} from './account'
import { getListing, LISTINGS, similarListings } from './catalog'
import {
  CHAT_SUMMARY,
  CONVERSATIONS,
  conversationsOf,
  FAILED_TEXT_IDS,
  mediaMessagesOf,
  messagesOf,
} from './chat'
import {
  COMMENTS,
  commentsOf,
  DEFAULT_SEARCH_HISTORY,
  HOT_SEARCHES,
  NOTIFICATIONS,
  SEARCH_FILTERS,
  SEARCH_PLACEHOLDER,
} from './discover'
import { mockPublicId } from './public-id'
import type {
  ConversationRole,
  HotSearchItem,
  ListingCategory,
  MockComment,
  MockConversation,
  MockListing,
  MockMediaMessage,
  MockMeetupCode,
  MockMessage,
  MockMyListing,
  MockNotification,
  MockSettings,
  MockTransaction,
  MockTransactionCounterpart,
  MockUser,
  MockUserProfile,
  MockWatcher,
  MockWish,
  MockWishPoolItem,
  MyListingStatusKey,
  SearchFilter,
} from './types'
import { getUser, ME, USERS } from './users'
import { WISHES } from './wishes'

export type {
  ConversationRole,
  HotSearchItem,
  ListingCategory,
  MockComment,
  MockConversation,
  MockListing,
  MockMediaMessage,
  MockMeetupCode,
  MockMessage,
  MockMyListing,
  MockNotification,
  MockSettings,
  MockTransaction,
  MockUser,
  MockUserProfile,
  MockWatcher,
  MockWish,
  MockWishPoolItem,
  MyListingStatusKey,
  SearchFilter,
}
export { mockPublicId }

/** 模拟网络往返，让加载态在演示时真实可见 */
const LATENCY = 120

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms)
  })
}

function normalize(text: string): string {
  return text.toLowerCase().trim()
}

/**
 * 分类 / 成色文案：实现在 `@/lib/listing-labels`（纯常量与纯函数，零 fixture 依赖），
 * 这里 re-export 保持既有 import 路径。文件内部仍直接用 `CATEGORY_LABEL`（见下方检索）。
 *
 * 金额格式化：实现已挪到 `@/lib/money`（真实页面不该为了一个纯函数静态 import
 * 整包 fixture，见该文件说明）。这里 re-export，既有 `@/mock/api` 的 import 路径
 * 与文件内部的调用都不受影响。
 */
export {
  CATEGORY_LABEL,
  categoryLabel,
  conditionLabel,
  formatAmount,
  formatYuan,
  HOME_CATEGORIES,
  WISH_CATEGORIES,
}

/* ------------------------------------------------------------------ 商品 */

type FeedArgs = {
  category?: ListingCategory | 'ALL'
  keyword?: string
  sort?: SearchFilter
  limit?: number
  offset?: number
}

export type FeedResult = {
  items: MockListing[]
  total: number
  hasMore: boolean
}

/** 搜索指纹：标题 + 规格 + 描述 + 分类中文名，全部小写后做子串匹配 */
function fingerprint(listing: MockListing): string {
  return normalize(
    `${listing.title} ${listing.spec} ${listing.description} ${CATEGORY_LABEL[listing.category]}`,
  )
}

/**
 * 「综合」排序的热度分：想要数权重是浏览量的 3 倍。
 *
 * 契约里没有 `views` / `wants`，真实数据下两者都是 `null`，所以比较时按 0 计，
 * 保证排序仍然是全序（缺值商品之间不会因为比较返回 0 而顺序不定）。
 */
function heat(item: MockListing): number {
  return (item.wants ?? 0) * 3 + (item.views ?? 0)
}

function sortListings(items: MockListing[], sort: SearchFilter | undefined): MockListing[] {
  switch (sort) {
    case '价格':
      return [...items].sort((a, b) => a.priceCents - b.priceCents)
    case '最新':
      return [...items].sort((a, b) => a.createdHoursAgo - b.createdHoursAgo)
    case '成色': {
      const rank: Record<MockListing['condition'], number> = {
        NEW: 0,
        LIKE_NEW: 1,
        GOOD: 2,
        FAIR: 3,
      }
      return [...items].sort((a, b) => rank[a.condition] - rank[b.condition])
    }
    default:
      // 综合：想要数 + 浏览量加权，热度高的在前
      return [...items].sort((a, b) => heat(b) - heat(a))
  }
}

export async function fetchFeed({
  category = 'ALL',
  keyword = '',
  sort,
  limit = 20,
  offset = 0,
}: FeedArgs = {}): Promise<FeedResult> {
  let items = LISTINGS.filter((listing) => listing.status === 'ACTIVE')
  if (category !== 'ALL') {
    items = items.filter((listing) => listing.category === category)
  }
  const kw = normalize(keyword)
  if (kw) {
    items = items.filter((listing) => fingerprint(listing).includes(kw))
  }
  const sorted = sortListings(items, sort)
  const page = sorted.slice(offset, offset + limit)
  return delay({ items: page, total: sorted.length, hasMore: offset + limit < sorted.length })
}

export const fetchHomeFeed = fetchFeed

export async function fetchCategoryListings(
  category: ListingCategory | 'ALL',
): Promise<MockListing[]> {
  const result = await fetchFeed({ category, limit: 50 })
  return result.items
}

/**
 * 详情页视图。
 *
 * **没有 `commentTotal`**：它曾是 `comments.length` 的副本（mock 与真实数据都这么填），
 * 页面改用本地留言树的长度后就没有消费方了。留一个「总数」字段只会让人以为
 * 列表是分页的 —— 真要分页时再按契约补。
 */
export type ListingDetailView = {
  listing: MockListing
  seller: MockUser
  comments: MockComment[]
  similar: MockListing[]
}

export async function fetchListingDetail(id: string): Promise<ListingDetailView | null> {
  const listing = getListing(id)
  if (!listing) return delay(null)
  const comments = commentsOf(listing.id)
  return delay({
    listing,
    seller: getUser(listing.sellerId),
    comments,
    similar: similarListings(id, 4),
  })
}

export function findListing(id: string): MockListing | undefined {
  return getListing(id)
}

/* ------------------------------------------------------------------ 搜索 */

export async function searchListings(
  keyword: string,
  sort: SearchFilter = '综合',
): Promise<FeedResult> {
  return fetchFeed({ keyword, sort, limit: 50 })
}

export function hotSearches(): HotSearchItem[] {
  return HOT_SEARCHES
}

export const searchFilters = SEARCH_FILTERS
export const searchPlaceholder = SEARCH_PLACEHOLDER
export const defaultSearchHistory = DEFAULT_SEARCH_HISTORY

/** 搜索建议：历史 + 热门去重后取前 6 条（点一下直接搜） */
export function suggestTerms(keyword: string): string[] {
  const kw = normalize(keyword)
  const pool = [...DEFAULT_SEARCH_HISTORY, ...HOT_SEARCHES.map((item) => item.term)]
  const unique = [...new Set(pool)]
  if (!kw) return unique.slice(0, 6)
  return unique.filter((term) => normalize(term).includes(kw)).slice(0, 6)
}

/* ------------------------------------------------------------------ 愿望 */

/**
 * 愿望分类的展示顺序：照契约 `wishCategorySchema` 的枚举顺序。
 * 许愿页的池子筛选与发布页的分类 chip 共用（中文名走 `categoryLabel`）。
 *
 * 类型取契约的 `WishCategory` 而不是 `ListingCategory`：两者当前逐值相同，
 * 但语义上「许愿的分类」以 `wishes/schema.ts` 为准（那边注释也说以后会合并成共享枚举）。
 */
export function myWishes(): MockWish[] {
  return WISHES.filter((wish) => wish.userId === ME.id)
}

/**
 * k-匿名门槛（镜像 `apps/api/src/modules/wishes/service.ts` 的 `POOL_MIN_COUNT`，契约未导出）。
 *
 * 只给页面文案用（「同一个关键词有 N 位以上同学在求」）；愿望池数据本身走真接口
 * （`features/wish/api.ts` 的 `fetchWishPool`）。
 */
export { POOL_MIN_COUNT } from './wishes'

/* ------------------------------------------------------------------ 消息 */

export function conversations(): MockConversation[] {
  return conversationsOf()
}

export function conversation(id: string): MockConversation | null {
  return CONVERSATIONS.find((item) => item.id === id) ?? null
}

export function messages(conversationId: string): MockMessage[] {
  return messagesOf(conversationId)
}

/** D2 媒体消息（契约外，见 `MockMediaMessage`） */
export function mediaMessages(conversationId: string): MockMediaMessage[] {
  return mediaMessagesOf(conversationId)
}

/** 1版稿：文本「发送失败」演示态的消息 id（契约外，见 `mock/chat.ts`） */
export function failedTextIds(): string[] {
  return FAILED_TEXT_IDS
}

export function chatSummary() {
  return CHAT_SUMMARY
}

/**
 * 给一批通知补上文案与跳转目标（`@/mock/api` 的兼容入口）。
 *
 * 真源已挪到 `@/features/notifications/decorate`（生产模块，零 fixture 依赖）；
 * 这里保留「省略 `resolve` 时退回 mock 目录」的旧行为，既有调用方不用改。
 */
export function decorateNotifications(
  items: NotificationDto[],
  resolve: ((listingId: string) => MockListing | undefined) | null | undefined = undefined,
): MockNotification[] {
  return decorateNotificationsWith(items, resolve === undefined ? findListing : resolve)
}

export function notifications(): MockNotification[] {
  return decorateNotifications(NOTIFICATIONS, findListing)
}

/** 未读数：契约字段 `readAt === null` 即未读（不额外造布尔字段） */
export function unreadNotificationCount(): number {
  return NOTIFICATIONS.filter((item) => item.readAt === null).length
}

export type ConversationFilter = 'all' | 'unread' | 'deal' | 'wish' | 'system'

/** 消息页筛选 Tab：全部 / 通知（= system）/ 交易 / 许愿；`unread` 仍留在类型里（UI 未提供） */
export function filterConversations(
  items: MockConversation[],
  filter: ConversationFilter,
): MockConversation[] {
  switch (filter) {
    case 'unread':
      return items.filter((item) => item.unreadCount > 0)
    case 'all':
      return items
    default:
      return items.filter((item) => item.kind === filter)
  }
}

export function countByFilter(items: MockConversation[]): { all: number; unread: number } {
  return {
    all: items.length,
    unread: items.filter((item) => item.unreadCount > 0).length,
  }
}

/* ------------------------------------------------------------------ 我的 */

export function myListings(): MockListing[] {
  return LISTINGS.filter((listing) => listing.sellerId === ME.id)
}

export function userListings(userId: string): MockListing[] {
  return LISTINGS.filter((listing) => listing.sellerId === userId)
}

export function profileStats() {
  const listings = myListings()
  return {
    activeListings: listings.filter((item) => item.status === 'ACTIVE').length,
    activeWishes: myWishes().filter((item) => item.status === 'ACTIVE').length,
    completedTransactions: TRANSACTIONS.filter((tx) => tx.status === 'COMPLETED').length,
  }
}

/* ------------------------------------------ A/B/C 组 14 张新稿新增的域 ------- */

/** 订单 / 交易视图：契约 `TransactionDto` 的 embedding 口径（商品与对方由数据层组装） */
export type OrderView = {
  transaction: MockTransaction
  listing: MockListing
  counterpart: MockTransactionCounterpart
}

/**
 * 「打开这一笔交易的会话」——对应 #72 / PR #82 的解析口径。
 *
 * 契约的 `TransactionDto` **没有** `conversationId`：会话由 (listingId, 对方) 唯一确定
 * （`POST /conversations { listingId }` 复用同一 (listing, 买家) 的会话）。
 * 所以页面不应该自己编一个会话 id，而是走这里解析；解析不到时页面按「目标已失效」处理。
 */
export function openConversation(listingId: string, counterpartId: string): string | null {
  const hit = conversations().find(
    (item) =>
      item.listing.id === mockPublicId('lst', listingId) &&
      item.counterpart.id === mockPublicId('usr', counterpartId),
  )
  return hit?.id ?? null
}

export async function fetchOrders(role: ConversationRole): Promise<OrderView[]> {
  const views = transactionsOf(role).flatMap((transaction) => {
    const listing = findListing(transaction.listingId)
    if (!listing) return []
    return [{ transaction, listing, counterpart: getUser(transaction.counterpartId) }]
  })
  return delay(views)
}

/** 单笔交易视图（A2 面交页用）：找不到交易或商品时返回 null，页面走「目标已失效」态 */
export function transactionView(id: string): OrderView | null {
  const transaction = TRANSACTION_BY_ID[id]
  if (!transaction) return null
  const listing = findListing(transaction.listingId)
  if (!listing) return null
  return { transaction, listing, counterpart: getUser(transaction.counterpartId) }
}

/* ---- 交易码（A2） ---- */

export function meetupCode(transactionId: string): MockMeetupCode {
  return meetupCodeOf(transactionId)
}

/** 「刷新」出新码（演示用） */
export function newMeetupCode(seed: number): string {
  return rotateMeetupCode(seed)
}

/* ---- 匹配结果（C3） ---- */

/**
 * 低于这个分数视为「可能不相关」，不再展示。
 *
 * 直接引用**契约**的值（`packages/contracts/src/matching/schema.ts`）：阈值是产品语义，
 * 不是 mock 数据 —— 小程序里曾写死 60，与后端口径不一致。
 *
 * 匹配列表本身已走真接口（`features/match/api.ts`；服务端按这个阈值过滤），
 * 这里只留常量给页面文案用（「低于 N% 的结果不展示」）。
 */
export { MATCH_SCORE_THRESHOLD }

/* ---- 他人主页（C2，契约无公开资料端点） ---- */

export function fetchUserProfile(userId: string): Promise<MockUserProfile> {
  return delay(userProfile(userId))
}

export function fetchUserListings(userId: string): Promise<MockListing[]> {
  return delay(userListings(userId).filter((item) => item.status === 'ACTIVE'))
}

/* ---- 想要的人（C5，契约无端点） ---- */

/** 「想要的人」页的默认商品（C5 稿子里那件：罗技 MX Keys 键盘） */
export const WATCHER_DEFAULT_LISTING = WATCHER_LISTING_ID

export function fetchWatchers(listingId?: string): Promise<MockWatcher[]> {
  const id = listingId ?? WATCHER_LISTING_ID
  return delay(WATCHERS.filter((item) => item.listingId === id))
}

export function watchersSummary(listingId?: string) {
  return watcherStats(listingId)
}

/** 某件商品有多少人想要（商品卡 / 我的发布行共用） */
export function wantsOf(listingId: string): number {
  return watcherCount(listingId)
}

/* ---- 认证 / 设置（B3 / B4） ---- */

export function verifyState() {
  return VERIFY
}

export function eduEmailOk(email: string): boolean {
  return isEduEmail(email)
}

export function settings(): MockSettings {
  return SETTINGS
}

export { APP_BUILD, APP_VERSION }

export const allUsers: MockUser[] = USERS

/** 当前登录用户（mock 固定为阿岚） */
export { getUser, ME }

/** 留言 fixture：演示构建（`TARO_APP_MOCK=1`）退 mock 时用（真实读路径是 #111 的 `GET /listings/:id/comments`） */
export const allComments: MockComment[] = COMMENTS

/* ---- D1 发布页增补（AI 润色；审核判定已由服务端接管，见 #74） ---- */

export { type PolishCandidate, polishCandidates } from './sell'

/** 该商品分类的「同款全新约 ¥X」参考价与建议定价区间（设计稿的 pnote） */
export function priceHint(listingId: string): string | null {
  const listing = findListing(listingId)
  if (!listing) return null
  const was = listing.originalPriceCents
  if (!was) return null
  const lo = Math.round((listing.priceCents * 0.85) / 100) * 100
  const hi = Math.round((listing.priceCents * 1.2) / 100) * 100
  return `同款全新约 ¥${formatAmount(was)} · 建议定价区间 ¥${formatAmount(lo)} ~ ¥${formatAmount(hi)}`
}
