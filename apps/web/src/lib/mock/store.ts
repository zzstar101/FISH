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
  Notification,
  NotificationView,
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

/**
 * 把种子商品里的标签归一成布尔字段。
 *
 * 种子里 `tags` 是唯一的事实来源（文案取自参考截图），但展示层要按开关判断
 * （角标只看「急出」、标签行只看「可小刀」），两边各读各的就会漂移。
 * 这里在装载时推导一次，之后全站只认 `urgent` / `negotiable`；发布时反向由
 * `draftTags` 写回 `tags`，形成闭环。
 */
function withDerivedFlags(item: Listing): Listing {
  return {
    ...item,
    negotiable: item.tags.includes('可小刀'),
    urgent: item.tags.includes('急出'),
  }
}

type Db = {
  listings: Listing[]
  comments: Record<string, Comment[]>
  conversations: Conversation[]
  wishes: Wish[]
  orders: Order[]
  favorites: string[]
  history: string[]
  followedUserIds: string[]
  notifications: Notification[]
}

function buildDb(): Db {
  return {
    listings: listings.map((item) => withDerivedFlags({ ...item })),
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
    // 通知是逐条可读可写的，深拷一层（含 payload），否则「标记已读」会改到 data.ts 的常量。
    notifications: notifications.map((item) => ({ ...item, payload: { ...item.payload } })),
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
  /** 急出：卡片角标 + 详情标签，同时写进 `tags` 让搜索能命中。 */
  urgent: boolean
  /** 可刀：写进 `tags`，列表里作为标签展示。 */
  negotiable: boolean
}

/**
 * 标签由 draft 的开关推导，而不是让调用方直接传数组：
 * `tags` 同时被搜索（`searchListings` 会匹配 tag）与列表标签渲染消费，
 * 两种展示（角标走 `urgent` 字段、标签走 `tags`）必须只有一个来源。
 *
 * 「免费送」与「急出」可以并存（0 元的东西也可能急着出手），所以免费时只跳过「可小刀」
 * （都已经免费了谈不上还价）。这里**不能**因为 free 就整体提前返回：那样会连独立的
 * 急出标记一起丢掉，而 `withDerivedFlags` 会据 tags 把它还原成 `urgent: false`。
 */
function draftTags(draft: ListingDraft): string[] {
  const tags: string[] = draft.free ? ['免费送'] : []
  if (draft.urgent) tags.push('急出')
  if (!draft.free && draft.negotiable) tags.push('可小刀')
  return tags
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
  // 布尔标志不在这里写死：`withDerivedFlags` 会从 tags 推导，保持单一来源。
  const listing = withDerivedFlags({
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
    tags: draftTags(draft),
    description: toDescriptionLines(draft.description),
    publishedMinutesAgo: 0,
    views: 0,
    wantCount: 0,
    status: 'ACTIVE',
    sellerId: ME_ID,
    kind: 'listing',
    free: draft.free,
  } satisfies Listing)
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
      ? withDerivedFlags({
          ...item,
          title: draft.title,
          description: toDescriptionLines(draft.description),
          category: draft.category,
          condition: draft.condition,
          campus: draft.campus,
          tradeMethod: draft.tradeMethod,
          tags: draftTags(draft),
          priceCents: draft.priceCents,
          originalPriceCents: draft.originalPriceCents,
          free: draft.free,
        })
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

export type { NotificationView }

/**
 * 通知文案由前端按 `type` + `payload` 组装（表里只存 type/payload，见 #23 决定记录）。
 * 放在 store 的 adapter 里而不是组件里：换文案不用碰 UI，将来接真实接口时
 * 只需把 `title` 从服务端取的值替进来。
 */
function decorateNotification(item: Notification): NotificationView {
  if (item.type === 'SYSTEM') {
    return {
      ...item,
      description: '建议在校内公共区域当面交易,注意核验物品',
      emoji: '🔔',
      target: null,
      title: '校园小助手',
      tone: 'warn',
    }
  }

  // MATCH：愿望 ↔ 商品首次命中。文案用「目标商品」表述，跳转前确认它还在。
  const listingId = item.payload.listingId
  const listing = listingId ? db.listings.find((entry) => entry.id === listingId) : undefined
  return {
    ...item,
    description: listing
      ? `${listing.title} · ${formatYuanText(listing.priceCents)}`
      : '这条匹配对应的商品已经被下架了',
    emoji: '🎉',
    // 目标不存在就退回愿望页（愿望详情在那边），而不是给一个点不动的死入口。
    target: listing ? { listingId: listing.id, to: '/detail/$listingId' } : { to: '/wish' },
    title: listing ? '你要的闲置出现了' : '有新的匹配',
    tone: 'mint',
  }
}

/** 通知描述里的价格：与 `lib/format` 同口径，但 store 不依赖 UI 层的 format。 */
function formatYuanText(cents: number): string {
  if (cents === 0) return '免费送'
  const yuan = cents / 100
  return `¥${yuan % 1 === 0 ? yuan.toLocaleString('zh-CN') : yuan.toFixed(2)}`
}

export async function fetchNotifications(): Promise<{
  items: NotificationView[]
  allRead: boolean
}> {
  await delay()
  // 新的在前（与真实接口的 `created_at DESC, id DESC` 对齐）。
  const sorted = [...db.notifications].sort((a, b) => a.minutesAgo - b.minutesAgo)
  const items = sorted.map(decorateNotification)
  return { allRead: items.every((item) => item.read), items }
}

/**
 * 消息 tab 的总未读角标 = 会话未读 + 通知未读。
 *
 * 与 `fetchUnreadNotificationCount` 是两个数：#23 的 `GET /notifications/unread-count`
 * 只算通知（置顶行的红点用它），而底部导航的「消息」角标要连聊天一起算，
 * 否则有未读聊天时角标不亮。
 */
export async function fetchNotificationBadge(): Promise<number> {
  await delay(0)
  const unreadChats = db.conversations.reduce((sum, item) => sum + item.unread, 0)
  return unreadChats + db.notifications.filter((item) => !item.read).length
}

/** #23 的 `GET /notifications/unread-count`：只算通知，供置顶行红点使用。 */
export async function fetchUnreadNotificationCount(): Promise<number> {
  await delay(0)
  return db.notifications.filter((item) => !item.read).length
}

/** 点开单条通知即已读（幂等：已读再点仍是原值）。 */
export async function markNotificationRead(id: string): Promise<void> {
  await delay(60)
  db.notifications = db.notifications.map((item) =>
    item.id === id ? { ...item, read: true } : item,
  )
}

/** 「全部已读」：通知与会话未读一起清（消息页右上角那个勾）。 */
export async function markAllNotificationsRead(): Promise<void> {
  await delay(60)
  db.notifications = db.notifications.map((item) => ({ ...item, read: true }))
  db.conversations = db.conversations.map((item) => ({ ...item, unread: 0 }))
}
