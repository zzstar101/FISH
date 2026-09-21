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
import type { WishCategory, WishCreateInput } from '@fish/contracts/wishes/schema'
import { formatAmount, formatYuan } from '@/lib/money'
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
import { getListing, LISTING_BY_ID, LISTINGS, similarListings } from './catalog'
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
import { matchesForWish, WISHES, wishPoolItems } from './wishes'

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

/**
 * 金额格式化：实现已挪到 `@/lib/money`（真实页面不该为了一个纯函数静态 import
 * 整包 fixture，见该文件说明）。这里 re-export，既有 `@/mock/api` 的 import 路径
 * 与文件内部的调用都不受影响。
 */
export { formatAmount, formatYuan }

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
  const comments = commentsOf(id)
  return delay({
    listing,
    seller: getUser(listing.sellerId),
    comments,
    similar: similarListings(id, 4),
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

/**
 * 愿望分类的展示顺序：照契约 `wishCategorySchema` 的枚举顺序。
 * 许愿页的池子筛选与发布页的分类 chip 共用（中文名走 `categoryLabel`）。
 *
 * 类型取契约的 `WishCategory` 而不是 `ListingCategory`：两者当前逐值相同，
 * 但语义上「许愿的分类」以 `wishes/schema.ts` 为准（那边注释也说以后会合并成共享枚举）。
 */
export const WISH_CATEGORIES: WishCategory[] = [
  'DIGITAL',
  'BOOKS',
  'BEAUTY',
  'DAILY',
  'SPORTS',
  'APPAREL',
  'TRANSPORT',
  'OTHER',
]

export function myWishes(): MockWish[] {
  return WISHES.filter((wish) => wish.userId === ME.id)
}

/** k-匿名门槛（镜像 `apps/api/src/modules/wishes/service.ts` 的 `POOL_MIN_COUNT`，契约未导出） */
export { POOL_MIN_COUNT } from './wishes'

/**
 * 愿望池（`GET /wishes/pool` 的聚合）。
 *
 * 聚合口径（按关键词聚合、`wantCount` 数不同用户、`>= POOL_MIN_COUNT` 才输出）见
 * `mock/wishes.ts` 的 `wishPoolItems`，那里列了与后端 SQL 的三处有意差异。
 */
export function wishPool(): MockWishPoolItem[] {
  return wishPoolItems()
}

export function wishMatches(wishId: string) {
  return matchesForWish(wishId)
    .map((match) => ({ match, listing: getListing(match.listingId) }))
    .filter((item): item is { match: typeof item.match; listing: MockListing } =>
      Boolean(item.listing),
    )
}

/**
 * 本地写：关闭愿望（`ACTIVE` → `CLOSED`）。
 *
 * 小程序端还没有 wish 客户端（属 #89），所以这里只改内存里的 fixture —— 真实端点是
 * `POST /wishes/:id/close`。返回「是否真的改了」，页面据此决定提示与列表刷新。
 *
 * ⚠️ 纯内存：**重进小程序（或刷新预览）就回到初始 fixture**，不做任何持久化。
 */
export function closeWishLocal(id: string): boolean {
  const wish = WISHES.find((item) => item.id === id)
  if (wish?.status !== 'ACTIVE') return false
  wish.status = 'CLOSED'
  return true
}

/** 本地发布愿望的 id 序号：用自增计数器而不是 `WISHES.length`，不依赖「数组只增不减」 */
let localWishSeq = 0

/**
 * 本地写：发布愿望。
 *
 * 入参由页面按 `wishCreateInputSchema` 校验并归一化（keyword 已 trim + 转小写、
 * 预算已由元转分）。真实端点是 `POST /wishes`；这里只往 fixture 头部插一条，
 * 让「发布成功 → 返回许愿页」能看到它，也让状态计数跟着变。
 *
 * ⚠️ 同样纯内存，重进即丢失。
 */
export function createWishLocal(input: WishCreateInput): MockWish {
  localWishSeq += 1
  const wish: MockWish = {
    id: `w-local-${localWishSeq}`,
    userId: ME.id,
    keyword: input.keyword,
    category: input.category,
    budgetMinCents: input.budgetMinCents,
    budgetMaxCents: input.budgetMaxCents,
    description: input.description ?? null,
    acceptSimilar: input.acceptSimilar,
    status: 'ACTIVE',
    matchCount: 0,
    createdAt: new Date().toISOString(),
    campus: ME.campus,
    timeLabel: '刚刚',
  }
  WISHES.unshift(wish)
  return wish
}

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
 * 通知文案 / 跳转目标由前端按 `type` + `payload` 组装（#23：服务端不存文案）。
 *
 * 放在数据层而不是页面里 —— 与 web 端 `apps/web/src/lib/mock/store.ts` 的
 * `decorateNotification` 同一口径：改文案不用碰 UI；换真实接口时把 title/description
 * 从服务端替进来即可。目标商品已删除/下架时退回愿望页，而不是给一个点不动的死入口。
 *
 * `resolve` 是「拿 listingId 查商品标题」的能力。默认查 mock 目录（fixture 场景）；
 * **真实接口的数据必须显式传 `null`**，原因见 `decorateNotifications` 的注释。
 */
function decorateNotification(
  item: NotificationDto,
  resolve: ((listingId: string) => MockListing | undefined) | null = findListing,
): MockNotification {
  if (item.type === 'MATCH') {
    const listingId = item.payload.listingId
    const listing = listingId && resolve ? resolve(listingId) : undefined
    const wishId = item.payload.wishId

    // 没有查询能力时（真实接口）只能给通用文案 + 原地板的跳转目标。
    // 不能因为「查不到标题」就说「已被下架」—— 那是把「不知道」说成了「不存在」。
    if (!resolve) {
      return {
        ...item,
        title: '有新的匹配',
        description: '',
        tone: 'mint',
        target: listingId
          ? { kind: 'listing', listingId }
          : wishId
            ? { kind: 'wish', wishId }
            : null,
      }
    }

    return {
      ...item,
      title: listing ? '你要的闲置出现了' : '有新的匹配',
      description: listing
        ? `${listing.title} · ¥${formatAmount(listing.priceCents)}`
        : '这条匹配对应的商品已经被下架了',
      tone: listing ? 'mint' : 'warn',
      target: listing
        ? { kind: 'listing', listingId: listing.id }
        : wishId
          ? { kind: 'wish', wishId }
          : null,
    }
  }
  // 契约 P0 只有 MATCH；#14 扩 type 时在这里加分支，页面不用动。
  return { ...item, title: '新通知', description: '', tone: 'warn', target: null }
}

/**
 * 给一批通知补上文案与跳转目标。
 *
 * `resolve` 省略时**退回 mock 目录**（演示/回退路径）；传 `null` 表示
 * 「确实没有查询能力」（真实接口路径）—— 此时只给通用文案并保留由 `payload`
 * 推出的跳转目标，**不谎称商品已下架**。
 * 这样「接真接口」与「退 mock」两条路都不会把「查不到」渲染成「不存在」。
 */
export function decorateNotifications(
  items: NotificationDto[],
  resolve: ((listingId: string) => MockListing | undefined) | null | undefined = undefined,
): MockNotification[] {
  const lookup = resolve === undefined ? findListing : resolve
  return items.map((item) => decorateNotification(item, lookup))
}

export function notifications(): MockNotification[] {
  return decorateNotifications(NOTIFICATIONS)
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

/**
 * 低于这个分数视为「可能不相关」，不再展示。
 *
 * 直接引用**契约**的值（`packages/contracts/src/matching/schema.ts`）：阈值是产品语义，
 * 不是 mock 数据 —— 小程序里曾写死 60，与后端口径不一致。
 */
export { MATCH_SCORE_THRESHOLD }

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

/**
 * 命中商品（同步版）。
 *
 * 与 `fetchMatches` 同一口径（阈值过滤 + 补卖家），区别只是不套 `delay`：
 * 许愿页的愿望卡要在渲染期同步取「命中了几件、是哪几件」。
 */
export function matchedListings(wishId: string): MatchView[] {
  return wishMatches(wishId)
    .filter(({ match }) => match.score >= MATCH_SCORE_THRESHOLD)
    .map(({ match, listing }) => ({ match, listing, seller: getUser(listing.sellerId) }))
}

export async function fetchMatches(wishId: string): Promise<MatchView[]> {
  return delay(matchedListings(wishId))
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

/** 留言 fixture：开发 / 预览退 mock 时用（真实读路径是 #111 的 `GET /listings/:id/comments`） */
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
