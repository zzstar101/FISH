import {
  categories,
  chatQuickPhrases,
  comments,
  conversations,
  listings,
  ME_ID,
  matchResults,
  notifications,
  orders,
  searchHistory,
  searchSuggestions,
  users,
  wishes,
} from './data'
import type {
  Campus,
  Comment,
  Conversation,
  Listing,
  ListingCategory,
  ListingStatus,
  NotificationEntry,
  Order,
  TradeMethod,
  User,
  Wish,
} from './types'

/**
 * 本地 Mock 数据源。
 *
 * 这一层**只做数据**，不含任何 React 依赖；页面通过各自的 `queries.ts`（TanStack Query）
 * 访问它。真实 API 到位后（#13）只需要把这些函数换成 `fetch`，组件不必改动。
 */

export type ListingView = Listing & {
  seller: User
  favorited: boolean
  /** 卖家在售件数（详情页卖家卡展示「在售 N 件」）。 */
  sellerActiveCount: number
}

export type CommentView = Comment & { user: User }

export type ConversationView = Conversation & {
  peer: User | null
  listing: Listing | null
  /** 当前登录用户（聊天页右侧气泡的头像），由 adapter 提供，组件不写死。 */
  self: User
}

export type OrderView = Order & { listing: Listing; counterpart: User }

export type WatcherView = { user: User; followedMinutesAgo: number }

type Db = {
  listings: Listing[]
  comments: Record<string, Comment[]>
  conversations: Conversation[]
  wishes: Wish[]
  orders: Order[]
  favorites: string[]
  history: string[]
  followedUserIds: string[]
  notificationsRead: boolean
}

function buildDb(): Db {
  return {
    listings: listings.map((item) => ({ ...item })),
    comments: Object.fromEntries(
      Object.entries(comments).map(([listingId, list]) => [
        listingId,
        list.map((item, index) => ({
          id: `${listingId}-c${index + 1}`,
          userId: item.userId,
          text: item.text,
          minutesAgo: item.minutesAgo,
        })),
      ]),
    ),
    conversations: conversations.map((item) => ({
      ...item,
      messages: item.messages.map((m) => ({ ...m })),
    })),
    wishes: wishes.map((item) => ({ ...item })),
    orders: orders.map((item) => ({ ...item })),
    favorites: ['p1', 'p5', 'p6'],
    history: ['p1', 'p5', 'p10', 'p4', 'p6'],
    followedUserIds: ['u1', 'u5'],
    notificationsRead: false,
  }
}

let db = buildDb()

/** 「清除演示数据」入口调用它。 */
export function resetDemoData(): void {
  db = buildDb()
}

const delay = (ms = 120) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function userById(id: string): User {
  const found = users.find((item) => item.id === id)
  if (!found) throw new Error(`mock user not found: ${id}`)
  return found
}

function decorate(listing: Listing): ListingView {
  return {
    ...listing,
    seller: userById(listing.sellerId),
    favorited: db.favorites.includes(listing.id),
    sellerActiveCount: db.listings.filter(
      (item) => item.sellerId === listing.sellerId && item.status === 'ACTIVE',
    ).length,
  }
}

export function getMe(): User {
  return userById(ME_ID)
}

export const meta = {
  categories,
  searchHistory,
  searchSuggestions,
  chatQuickPhrases,
  notifications,
}

/** 只展示在售商品：已售出/已下架不进 Feed、分类、搜索与同类推荐。 */
const isVisible = (item: Listing) => item.status === 'ACTIVE'

export async function fetchFeed(): Promise<ListingView[]> {
  await delay()
  return db.listings
    .filter(isVisible)
    .sort((a, b) => a.publishedMinutesAgo - b.publishedMinutesAgo)
    .map(decorate)
}

export async function fetchCategoryListings(categoryLabel: string | null): Promise<ListingView[]> {
  await delay()
  // 「热门闲置」按浏览量降序（参考截图 02 的 8 行严格递减）。
  return db.listings
    .filter((item) => item.category === categoryLabel && isVisible(item))
    .sort((a, b) => b.views - a.views)
    .map(decorate)
}

export type SearchSort = 'general' | 'latest' | 'price' | 'hot'

export async function searchListings(keyword: string, sort: SearchSort): Promise<ListingView[]> {
  await delay()
  const trimmed = keyword.trim()
  const matched = db.listings.filter((item) => {
    if (!trimmed || !isVisible(item)) return false
    return (
      item.title.includes(trimmed) ||
      item.category.includes(trimmed) ||
      item.tags.some((tag) => tag.includes(trimmed))
    )
  })

  const sorted = [...matched]
  if (sort === 'price') sorted.sort((a, b) => a.priceCents - b.priceCents)
  else if (sort === 'hot') sorted.sort((a, b) => b.wantCount - a.wantCount)
  else if (sort === 'latest') sorted.sort((a, b) => a.publishedMinutesAgo - b.publishedMinutesAgo)
  else sorted.sort((a, b) => a.publishedMinutesAgo - b.publishedMinutesAgo)

  return sorted.map(decorate)
}

export async function fetchListing(id: string): Promise<ListingView | null> {
  await delay()
  const found = db.listings.find((item) => item.id === id)
  return found ? decorate(found) : null
}

export async function fetchSimilarListings(id: string): Promise<ListingView[]> {
  await delay()
  const current = db.listings.find((item) => item.id === id)
  if (!current) return []
  return db.listings
    .filter((item) => item.id !== id && item.category === current.category && isVisible(item))
    .slice(0, 6)
    .map(decorate)
}

export async function fetchComments(listingId: string): Promise<CommentView[]> {
  await delay()
  const list = db.comments[listingId] ?? []
  return list.map((item) => ({ ...item, user: userById(item.userId) }))
}

export async function addComment(listingId: string, text: string): Promise<CommentView> {
  await delay()
  const entry: Comment = { id: `${listingId}-c${Date.now()}`, userId: ME_ID, text, minutesAgo: 0 }
  db.comments[listingId] = [...(db.comments[listingId] ?? []), entry]
  return { ...entry, user: getMe() }
}

export async function fetchWatchers(listingId: string): Promise<WatcherView[]> {
  await delay()
  const listing = db.listings.find((item) => item.id === listingId)
  if (!listing) return []
  const offsets = [0, 5, 23, 60, 120, 480]
  return users
    .filter((item) => item.id !== ME_ID && item.id !== listing.sellerId)
    .slice(0, 6)
    .map((user, index) => ({ user, followedMinutesAgo: offsets[index] ?? index * 60 }))
}

export async function fetchUser(id: string): Promise<User | null> {
  await delay()
  return users.find((item) => item.id === id) ?? null
}

export async function fetchUserListings(userId: string): Promise<ListingView[]> {
  await delay()
  return db.listings
    .filter((item) => item.sellerId === userId)
    .sort((a, b) => a.publishedMinutesAgo - b.publishedMinutesAgo)
    .map(decorate)
}

export async function toggleFavorite(listingId: string): Promise<boolean> {
  await delay(60)
  const has = db.favorites.includes(listingId)
  db.favorites = has ? db.favorites.filter((id) => id !== listingId) : [...db.favorites, listingId]
  return !has
}

export async function fetchFavoriteListings(): Promise<ListingView[]> {
  await delay()
  return db.favorites
    .map((id) => db.listings.find((item) => item.id === id))
    .filter((item): item is Listing => Boolean(item))
    .map(decorate)
}

export async function fetchHistory(): Promise<ListingView[]> {
  await delay()
  return db.history
    .map((id) => db.listings.find((item) => item.id === id))
    .filter((item): item is Listing => Boolean(item))
    .map(decorate)
}

export async function fetchFollowedUsers(): Promise<User[]> {
  await delay()
  return db.followedUserIds.map(userById)
}

export async function fetchMyListings(): Promise<ListingView[]> {
  await delay()
  return db.listings.filter((item) => item.sellerId === ME_ID).map(decorate)
}

export async function fetchSoldListings(): Promise<ListingView[]> {
  await delay()
  return db.listings
    .filter((item) => item.sellerId === ME_ID && item.status === 'SOLD')
    .map(decorate)
}

export async function fetchBoughtListings(): Promise<ListingView[]> {
  await delay()
  return db.orders
    .filter((order) => order.role === 'buy')
    .map((order) => db.listings.find((item) => item.id === order.listingId))
    .filter((item): item is Listing => Boolean(item))
    .map(decorate)
}

export type ListingDraft = {
  title: string
  description: string
  category: ListingCategory
  condition: string
  campus: Campus
  tradeMethod: TradeMethod
  priceCents: number
  originalPriceCents?: number
  emoji: string
  free: boolean
}

/** 描述按行存储；同一行只保留一次，详情页才能安全地拿文本当 key。 */
function toDescriptionLines(description: string): string[] {
  return [
    ...new Set(
      description
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ]
}

export async function createListing(draft: ListingDraft): Promise<ListingView> {
  await delay(300)
  const listing: Listing = {
    id: `p-${Date.now()}`,
    title: draft.title,
    priceCents: draft.priceCents,
    originalPriceCents: draft.originalPriceCents,
    emoji: draft.emoji,
    tone: 'violet',
    category: draft.category,
    condition: draft.condition,
    campus: draft.campus,
    tradeMethod: draft.tradeMethod,
    tags: draft.free ? ['免费送'] : [],
    description: toDescriptionLines(draft.description),
    publishedMinutesAgo: 0,
    views: 0,
    wantCount: 0,
    status: 'ACTIVE',
    sellerId: ME_ID,
    kind: 'listing',
    free: draft.free,
  }
  db.listings = [listing, ...db.listings]
  return decorate(listing)
}

export async function setListingStatus(listingId: string, status: ListingStatus): Promise<void> {
  await delay(200)
  db.listings = db.listings.map((item) => (item.id === listingId ? { ...item, status } : item))
}

/** 编辑已发布的商品（#6 的写路径之一，入口在「我发布的」）。 */
export async function updateListing(listingId: string, draft: ListingDraft): Promise<void> {
  await delay(300)
  db.listings = db.listings.map((item) =>
    item.id === listingId
      ? {
          ...item,
          title: draft.title,
          description: toDescriptionLines(draft.description),
          category: draft.category,
          condition: draft.condition,
          campus: draft.campus,
          tradeMethod: draft.tradeMethod,
          priceCents: draft.priceCents,
          originalPriceCents: draft.originalPriceCents,
          free: draft.free,
        }
      : item,
  )
}

/** 关注 / 取关同校同学（用户主页的「关注」）。 */
export async function toggleFollow(userId: string): Promise<boolean> {
  await delay(120)
  const following = db.followedUserIds.includes(userId)
  db.followedUserIds = following
    ? db.followedUserIds.filter((id) => id !== userId)
    : [...db.followedUserIds, userId]
  return !following
}

export async function isFollowing(userId: string): Promise<boolean> {
  await delay(0)
  return db.followedUserIds.includes(userId)
}

export async function removeListing(listingId: string): Promise<void> {
  await delay(200)
  db.listings = db.listings.filter((item) => item.id !== listingId)
}

function decorateConversation(item: Conversation): ConversationView {
  return {
    ...item,
    peer: item.userId ? userById(item.userId) : null,
    listing: item.listingId ? (db.listings.find((l) => l.id === item.listingId) ?? null) : null,
    self: getMe(),
  }
}

export async function fetchConversations(): Promise<ConversationView[]> {
  await delay()
  return db.conversations
    .map(decorateConversation)
    .sort((a, b) => a.updatedMinutesAgo - b.updatedMinutesAgo)
}

export async function fetchConversation(id: string): Promise<ConversationView | null> {
  await delay()
  const found = db.conversations.find((item) => item.id === id)
  if (!found) return null
  // 打开会话即已读（真实实现由服务端标记）。
  found.unread = 0
  return decorateConversation(found)
}

export async function sendMessage(conversationId: string, text: string): Promise<void> {
  await delay(120)
  const conversation = db.conversations.find((item) => item.id === conversationId)
  if (!conversation) return
  conversation.messages = [
    ...conversation.messages,
    { id: `m-${Date.now()}`, from: 'me', text, sentAtMinutesAgo: 0, kind: 'TEXT' },
  ]
  conversation.updatedMinutesAgo = 0
}

export async function markAllNotificationsRead(): Promise<void> {
  await delay(60)
  db.notificationsRead = true
  db.conversations = db.conversations.map((item) => ({ ...item, unread: 0 }))
}

/** 复用/创建会话：「我想要」「聊一聊」统一走这里。 */
export async function openConversationWith(peerId: string, listingId?: string): Promise<string> {
  await delay(120)
  const existing = db.conversations.find(
    (item) => item.userId === peerId && (!listingId || item.listingId === listingId),
  )
  if (existing) return existing.id
  const id = `c-${Date.now()}`
  db.conversations = [
    ...db.conversations,
    {
      id,
      kind: 'peer',
      title: userById(peerId).nickname,
      userId: peerId,
      listingId,
      unread: 0,
      updatedMinutesAgo: 0,
      messages: [],
    },
  ]
  return id
}

/** 愿望 + 发起人：页面不直接读 `data.ts`，用户信息一律由 store 装配。 */
export type WishView = Wish & { owner: User }

export async function fetchWishes(): Promise<{
  wall: WishView[]
  mine: WishView[]
  matchedListings: number
}> {
  await delay()
  const decorateWish = (wish: Wish): WishView => ({ ...wish, owner: userById(wish.userId) })
  return {
    wall: db.wishes.filter((item) => !item.mine).map(decorateWish),
    mine: db.wishes.filter((item) => item.mine).map(decorateWish),
    matchedListings: 25,
  }
}

export async function createWish(keyword: string, budgetCents: number): Promise<Wish> {
  await delay(200)
  const wish: Wish = {
    id: `w-${Date.now()}`,
    userId: ME_ID,
    // #7 契约：关键词 trim 后统一转小写（schema 的 transform）。
    keyword: keyword.trim().toLowerCase(),
    budgetCents,
    minutesAgo: 0,
    helpers: 0,
    matchedCount: 0,
    mine: true,
  }
  db.wishes = [wish, ...db.wishes]
  return wish
}

export async function closeWish(id: string): Promise<void> {
  await delay(150)
  db.wishes = db.wishes.filter((item) => item.id !== id)
}

export async function fetchOrders(role: 'buy' | 'sell'): Promise<OrderView[]> {
  await delay()
  return db.orders
    .filter((item) => item.role === role)
    .map((order) => {
      const listing = db.listings.find((item) => item.id === order.listingId)
      if (!listing) return null
      return { ...order, listing, counterpart: userById(order.counterpartId) }
    })
    .filter((item): item is OrderView => item !== null)
    .sort((a, b) => a.minutesAgo - b.minutesAgo)
}

/** 卖家接受交易请求：Listing 锁定为 RESERVED，交易进入待面交（#11）。 */
export async function acceptOrder(orderId: string): Promise<void> {
  await delay(200)
  const order = db.orders.find((item) => item.id === orderId)
  if (!order) return
  db.orders = db.orders.map((item) =>
    item.id === orderId ? { ...item, status: 'PENDING_MEETUP' } : item,
  )
  db.listings = db.listings.map((item) =>
    item.id === order.listingId ? { ...item, status: 'RESERVED' } : item,
  )
}

/** 卖家拒绝交易请求：Listing 保持 ACTIVE，交易进入 REJECTED（#11）。 */
export async function rejectOrder(orderId: string): Promise<void> {
  await delay(200)
  const order = db.orders.find((item) => item.id === orderId)
  if (!order) return
  db.orders = db.orders.map((item) =>
    item.id === orderId ? { ...item, status: 'REJECTED' } : item,
  )
  db.listings = db.listings.map((item) =>
    item.id === order.listingId ? { ...item, status: 'ACTIVE' } : item,
  )
}

/** 买家发起交易确认：创建一条 REQUESTED 订单（#11 的第一步写操作）。 */
export async function requestOrder(listingId: string): Promise<string> {
  await delay(200)
  const listing = db.listings.find((item) => item.id === listingId)
  if (!listing) throw new Error('listing not found')
  const existing = db.orders.find(
    (item) =>
      item.listingId === listingId &&
      item.role === 'buy' &&
      (item.status === 'REQUESTED' || item.status === 'PENDING_MEETUP'),
  )
  if (existing) return existing.id
  const id = `o-${Date.now()}`
  db.orders = [
    ...db.orders,
    {
      id,
      role: 'buy',
      listingId,
      counterpartId: listing.sellerId,
      status: 'REQUESTED',
      minutesAgo: 0,
    },
  ]
  return id
}

export async function cancelOrder(orderId: string): Promise<void> {
  await delay(200)
  const order = db.orders.find((item) => item.id === orderId)
  if (!order) return
  db.orders = db.orders.map((item) =>
    item.id === orderId ? { ...item, status: 'CANCELLED' } : item,
  )
  db.listings = db.listings.map((item) =>
    item.id === order.listingId ? { ...item, status: 'ACTIVE' } : item,
  )
}

export async function finishOrder(orderId: string): Promise<void> {
  await delay(200)
  const order = db.orders.find((item) => item.id === orderId)
  if (!order) return
  db.orders = db.orders.map((item) =>
    item.id === orderId ? { ...item, status: 'COMPLETED' } : item,
  )
  db.listings = db.listings.map((item) =>
    item.id === order.listingId ? { ...item, status: 'SOLD' } : item,
  )
}

export async function fetchMatches(
  listingId: string,
): Promise<{ listing: ListingView | null; results: typeof matchResults }> {
  await delay()
  const listing = db.listings.find((item) => item.id === listingId)
  return { listing: listing ? decorate(listing) : null, results: matchResults }
}

export type ProfileSummary = {
  me: User
  stats: { published: number; sold: number; bought: number; favorites: number }
  orderInProgress: number
  wishCount: number
  historyCount: number
  followCount: number
}

export async function fetchProfileSummary(): Promise<ProfileSummary> {
  await delay()
  return {
    me: getMe(),
    stats: {
      published: db.listings.filter((item) => item.sellerId === ME_ID).length,
      sold: db.listings.filter((item) => item.sellerId === ME_ID && item.status === 'SOLD').length,
      // 「买到」= 已完成的买入交易。
      bought: db.orders.filter((item) => item.role === 'buy' && item.status === 'COMPLETED').length,
      favorites: db.favorites.length,
    },
    // 进行中 = 请求中 + 待面交，买卖两侧都算。
    orderInProgress: db.orders.filter(
      (item) => item.status === 'REQUESTED' || item.status === 'PENDING_MEETUP',
    ).length,
    wishCount: db.wishes.filter((item) => item.mine).length,
    historyCount: db.history.length,
    followCount: db.followedUserIds.length,
  }
}

export type NotificationView = NotificationEntry & { read: boolean }

export async function fetchNotifications(): Promise<{
  items: NotificationView[]
  allRead: boolean
}> {
  await delay()
  const items = notifications.map((item) => ({ ...item, read: db.notificationsRead }))
  return { items, allRead: db.notificationsRead }
}

export async function fetchNotificationBadge(): Promise<number> {
  await delay(0)
  const unreadChats = db.conversations.reduce((sum, item) => sum + item.unread, 0)
  return db.notificationsRead ? unreadChats : unreadChats + notifications.length
}
