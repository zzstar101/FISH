/**
 * Mock 数据访问层（唯一入口）。
 *
 * 页面只允许从这里取数据；将来接真实 API 时，改这一个文件即可，页面不动。
 * 所有函数返回 Promise（真实接口也是异步），并带一点延迟让加载态在演示中可见。
 *
 * 与真实契约的边界：商品/愿望/会话/消息/通知的字段都对齐 `packages/contracts`；
 * 留言（comments）在契约里不存在，是本文件内的纯展示 mock（`discover.ts` 有标注）。
 */
import {
  APP_BUILD,
  APP_VERSION,
  isEduEmail,
  MY_LISTINGS,
  meetupCodeOf,
  myListingCounts,
  rotateMeetupCode,
  SETTINGS,
  THEME_OPTIONS,
  TRANSACTION_BY_ID,
  TRANSACTIONS,
  transactionCounts,
  transactionOverview,
  transactionsOf,
  userProfile,
  VERIFY,
  WATCHER_LISTING_ID,
  WATCHERS,
  watcherCount,
  watcherStats,
} from './account'
import {
  CATEGORY_ORDER,
  CATEGORY_TITLE,
  getListing,
  LISTING_BY_ID,
  LISTINGS,
  SUB_CATEGORIES,
  similarListings,
} from './catalog'
import { CHAT_SUMMARY, CONVERSATIONS, conversationsOf, mediaMessagesOf, messagesOf } from './chat'
import {
  COMMENTS,
  commentsOf,
  DEFAULT_SEARCH_HISTORY,
  HOT_SEARCHES,
  NOTIFICATIONS,
  SEARCH_FILTERS,
  SEARCH_PLACEHOLDER,
} from './discover'
import type {
  ConversationRole,
  HotSearchItem,
  ListingCategory,
  MockComment,
  MockConversation,
  MockListing,
  MockMatch,
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
import {
  FEATURED_WISH_ID,
  HOT_WISH_TAGS,
  matchesForWish,
  WISH_FILTERS,
  WISH_POOL,
  WISH_STATS,
  WISHES,
} from './wishes'

export type {
  ConversationRole,
  HotSearchItem,
  ListingCategory,
  MockComment,
  MockConversation,
  MockListing,
  MockMatch,
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

const CATEGORY_LABEL: Record<ListingCategory, string> = {
  DIGITAL: '数码电子',
  BOOKS: '教材书籍',
  BEAUTY: '美妆洗护',
  DAILY: '宿舍好物',
  SPORTS: '运动户外',
  APPAREL: '服饰鞋包',
  TRANSPORT: '代步出行',
  OTHER: '其他闲置',
}

/** 设计稿顶部横滑分类（第一项是「推荐」= 全部） */
export const HOME_CATEGORIES: { key: ListingCategory | 'ALL'; label: string }[] = [
  { key: 'ALL', label: '推荐' },
  { key: 'BOOKS', label: '教材书籍' },
  { key: 'DIGITAL', label: '数码电子' },
  { key: 'TRANSPORT', label: '代步出行' },
  { key: 'DAILY', label: '宿舍好物' },
  { key: 'SPORTS', label: '运动户外' },
  { key: 'APPAREL', label: '服饰鞋包' },
  { key: 'BEAUTY', label: '美妆洗护' },
  { key: 'OTHER', label: '其他闲置' },
]

export function categoryLabel(category: ListingCategory): string {
  return CATEGORY_LABEL[category]
}

export function conditionLabel(condition: MockListing['condition']): string {
  switch (condition) {
    case 'NEW':
      return '全新'
    case 'LIKE_NEW':
      return '九成新'
    case 'GOOD':
      return '八成新'
    default:
      return '七成新'
  }
}

/** 金额（整数分）→ 展示用「¥160」/「¥1,580」 */
export function formatYuan(cents: number): string {
  const yuan = cents / 100
  const text = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
  return `¥${text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

/** 只要数字部分（设计稿里 ¥ 和数字是分开排版的） */
export function formatAmount(cents: number): string {
  const yuan = cents / 100
  const text = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
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
      return [...items].sort((a, b) => b.wants * 3 + b.views - (a.wants * 3 + a.views))
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

export type ListingDetailView = {
  listing: MockListing
  seller: MockUser
  comments: MockComment[]
  similar: MockListing[]
  commentTotal: number
}

export async function fetchListingDetail(id: string): Promise<ListingDetailView | null> {
  const listing = getListing(id)
  if (!listing) return delay(null)
  const comments = commentsOf(id)
  return delay({
    listing,
    seller: getUser(listing.sellerId),
    comments,
    similar: similarListings(id, 4),
    commentTotal: comments.length,
  })
}

export function findListing(id: string): MockListing | undefined {
  return LISTING_BY_ID[id]
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

export function myWishes(): MockWish[] {
  return WISHES.filter((wish) => wish.userId === ME.id)
}

const WISH_CATEGORY_BY_FILTER: Record<string, ListingCategory> = {
  教材书籍: 'BOOKS',
  数码电子: 'DIGITAL',
  代步出行: 'TRANSPORT',
  宿舍好物: 'DAILY',
  运动户外: 'SPORTS',
  服饰鞋包: 'APPAREL',
  美妆洗护: 'BEAUTY',
}

export function wishWall(filter: string): MockWish[] {
  const active = WISHES.filter((wish) => wish.status === 'ACTIVE')
  if (filter === '已匹配') return active.filter((wish) => wish.matchCount > 0)
  if (filter === '全部') return active
  const category = WISH_CATEGORY_BY_FILTER[filter]
  if (!category) return active
  return active.filter((wish) => wish.category === category)
}

export function featuredWish(): MockWish {
  const found = WISHES.find((wish) => wish.id === FEATURED_WISH_ID)
  if (found) return found
  const fallback = WISHES[0]
  if (!fallback) throw new Error('WISHES 为空：mock 数据未初始化')
  return fallback
}

export function wishPool(): MockWishPoolItem[] {
  return WISH_POOL
}

export function wishMatches(wishId: string) {
  return matchesForWish(wishId)
    .map((match) => ({ match, listing: getListing(match.listingId) }))
    .filter((item): item is { match: typeof item.match; listing: MockListing } =>
      Boolean(item.listing),
    )
}

export const wishFilters = WISH_FILTERS
export const hotWishTags = HOT_WISH_TAGS
export const wishStats = WISH_STATS

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

export function chatSummary() {
  return CHAT_SUMMARY
}

export function notifications(): MockNotification[] {
  return NOTIFICATIONS
}

export function unreadNotificationCount(): number {
  return NOTIFICATIONS.filter((item) => !item.read).length
}

export type ConversationFilter = 'all' | 'unread' | 'deal' | 'wish' | 'system'

/** 消息页筛选：全部 / 未读 / 交易 / 许愿 / 系统 */
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
    (item) => item.listing.id === listingId && item.counterpart.id === counterpartId,
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

export function orderCounts(role: ConversationRole) {
  return transactionCounts(role)
}

export function orderOverview() {
  return transactionOverview()
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

/** 低于这个分数视为「可能不相关」，不再展示（`matching/schema.ts` 的 MATCH_SCORE_THRESHOLD 语义） */
export const MATCH_SCORE_THRESHOLD = 60

export type MatchView = {
  match: MockMatch
  listing: MockListing
  seller: MockUser
}

/** 匹配到的愿望（C3 页头那张吊牌） */
export function findWish(id: string): MockWish | undefined {
  return WISHES.find((wish) => wish.id === id)
}

/** C3 的默认愿望：稿子里那条「显示器」 */
export const MATCH_DEFAULT_WISH = 'w-011'

export async function fetchMatches(wishId: string): Promise<MatchView[]> {
  // 复用已有的 wishMatches（它已经把 match 与 listing 配好），这里只补卖家与阈值过滤
  const views = wishMatches(wishId)
    .filter(({ match }) => match.score >= MATCH_SCORE_THRESHOLD)
    .map(({ match, listing }) => ({ match, listing, seller: getUser(listing.sellerId) }))
  return delay(views)
}

/* ---- 分类页（C1） ---- */

export { CATEGORY_ORDER, SUB_CATEGORIES }

export function categoryTitle(category: ListingCategory): string {
  return CATEGORY_TITLE[category]
}

/** 一级分类的在售件数（C1 左栏「128 件」） */
export function categoryCount(category: ListingCategory): number {
  return LISTINGS.filter((l) => l.category === category && l.status === 'ACTIVE').length
}

/** 二级分类在售件数（C1 排序行右下角「32 件」） */
export function subCategoryCount(category: ListingCategory, sub: string): number {
  return LISTINGS.filter((l) => l.category === category && l.sub === sub && l.status === 'ACTIVE')
    .length
}

/* ---- 他人主页（C2，契约无公开资料端点） ---- */

export function fetchUserProfile(userId: string): Promise<MockUserProfile> {
  return delay(userProfile(userId))
}

export function fetchUserListings(userId: string): Promise<MockListing[]> {
  return delay(userListings(userId).filter((item) => item.status === 'ACTIVE'))
}

/* ---- 我的发布（C4） ---- */

export function fetchMyListings(): Promise<MockMyListing[]> {
  return delay(MY_LISTINGS)
}

export function myListingStats() {
  return myListingCounts()
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

export const themeOptions = THEME_OPTIONS
export { APP_BUILD, APP_VERSION }

export const allUsers: MockUser[] = USERS

/** 当前登录用户（mock 固定为阿岚） */
export { getUser, ME }

/** 留言是纯展示数据（契约无 comments 域），单独导出方便调试 */
export const allComments: MockComment[] = COMMENTS

/* ---- D1 发布页增补（AI 润色 / 审核失败） ---- */

export {
  findViolations,
  type ModerationResult,
  moderate,
  type PolishCandidate,
  polishCandidates,
} from './sell'

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
