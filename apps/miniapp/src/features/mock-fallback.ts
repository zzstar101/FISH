/**
 * 演示兜底（fixture）数据的**唯一入口** —— 生产构建会被 `mock-fallback.prod.ts` 整个替换掉。
 *
 * ## 为什么要有这一层
 *
 * `fetchers.ts` 原先在文件头**静态** import 了 `@/mock/account` 与 `@/mock/api`，
 * 实际只为了 `demoProfile()` 里的几个数字。静态 import 与「这个值只在
 * `MOCK_FALLBACK_ENABLED` 为真时才用」是两回事：模块图照单全收，于是整包演示
 * fixture（catalog / chat / account / users / wishes / discover）都被拖进首屏 chunk
 * 并在冷启动时求值。上一轮把纯文案与版本常量挪进 `@/lib/*` 只是第一步 ——
 * re-export 不减小模块图，**必须让生产构建根本不解析这些文件**。
 *
 * 所以把「只在兜底分支里用的 fixture 取值」全部收进本文件，生产构建用
 * `apps/miniapp/config/index.ts` 的 alias 把 `@/features/mock-fallback` 指向
 * `mock-fallback.prod.ts`（零 `@/mock/*` 依赖），fixture 子图就从首屏图里消失了。
 *
 * ## 纪律
 *
 * - 本文件**不判断** `MOCK_FALLBACK_ENABLED`：分支判断留在原调用点，这里只负责
 *   「把 fixture 取出来」；否则生产桩要跟着复刻一遍分支逻辑。
 * - 只放**只在兜底分支里用**的取值。`decorateNotifications` 这类成功路径也要用的
 *   函数留在 `fetchers.ts`，不能挪进来。
 * - 函数名一律 `demo*` 前缀：调用点一眼看出「这里退的是演示数据」。
 * - 返回值与调用点原先就地取值时**完全一致**（含 `.filter(kind !== 'system')` 之类
 *   的口径）。本文件是纯搬迁，不夹带任何行为改动。
 */
import type { Me } from '@fish/contracts/auth/user'
import type { ListingCategory } from '@fish/contracts/listings/schema'
import type { TransactionRole } from '@fish/contracts/transactions/schema'
import { MY_LISTINGS, myListingCounts, TRANSACTIONS } from '@/mock/account'
import {
  conversation,
  conversations,
  fetchCategoryListings,
  fetchHomeFeed,
  fetchListingDetail,
  fetchOrders,
  type ListingDetailView,
  ME,
  messages,
  mockPublicId,
  myListings,
  myWishes,
  notifications,
  type OrderView,
  openConversation,
  searchListings,
  unreadNotificationCount,
  userListings,
} from '@/mock/api'
import type {
  MockConversation,
  MockListing,
  MockMessage,
  MockNotification,
  MockUser,
  MockWish,
  SearchFilter,
} from '@/mock/types'
import { USERS } from '@/mock/users'

/* --------------------------------------------------------------- 商品 */

/** 首页 feed 的兜底（`loadHomeFeed` 的 catch） */
export async function demoHomeFeed(category: ListingCategory | 'ALL'): Promise<MockListing[]> {
  const result = await fetchHomeFeed({ category, limit: 40 })
  return result.items
}

/** 分类列表的兜底（`loadCategoryListings` 的 catch） */
export function demoCategoryListings(category: ListingCategory): Promise<MockListing[]> {
  return fetchCategoryListings(category)
}

/** 搜索结果的兜底（`loadSearch` 的 catch） */
export async function demoSearchListings(
  keyword: string,
  sortLabel: SearchFilter,
): Promise<MockListing[]> {
  const result = await searchListings(keyword, sortLabel)
  return result.items
}

/** 商品详情的兜底（`loadListingDetail` 的 catch）；`null` = fixture 里没有这个 id */
export function demoListingDetail(id: string): Promise<ListingDetailView | null> {
  return fetchListingDetail(id)
}

/* --------------------------------------------------------------- 通知 / 会话 */

/** 通知列表的兜底（`loadNotifications` 的 catch） */
export function demoNotifications(): MockNotification[] {
  return notifications()
}

/**
 * 会话列表的兜底（`loadConversations` 的 catch）。
 *
 * fixture 里的「系统会话」（`kind === 'system'`）是契约外的展示扩展：它不是
 * (商品, 买家×卖家) 的会话，`counterpart` 就是当前用户自己。本轮已按 Owner 决策
 * 删掉系统会话行，所以兜底也在这里滤掉 —— 底栏红点用同一个口径（见
 * `demoTabbarUnread`），两处不能分叉。
 */
export function demoConversationFixtures(): {
  items: MockConversation[]
  viewerId: Me['id']
} {
  return {
    items: conversations().filter((item) => item.kind !== 'system'),
    viewerId: demoViewerId(),
  }
}

/** 会话详情的兜底（`loadConversation` 的 catch）；`null` = fixture 里没有这个 id */
export function demoConversation(id: string): MockConversation | null {
  return conversation(id)
}

/** 会话消息的兜底（`loadConversation` / `loadMessagePage` 的 catch） */
export function demoMessages(conversationId: string): MockMessage[] {
  return messages(conversationId)
}

/**
 * fixture 里的「我」（`ME`）。
 *
 * 演示构建里当前登录身份是 `DEMO_USER`（`features/auth/demo.ts`），与 fixture 的
 * `ME` 不是同一个人；只有「mock 开、演示登录态关」的构建才用得上这个原始用户。
 */
export function demoViewer(): MockUser {
  return ME
}

/** fixture「我」的规范公开 id（契约 DTO 只认公开 id，不认 fixture 原始键） */
export function demoViewerId(): Me['id'] {
  return mockPublicId('usr', ME.id)
}

/**
 * 「TA的宝贝」兜底（`loadCounterpartListings`）：公开 id → fixture 用户的在售商品。
 *
 * 必须先把**公开 id 反查回 fixture 键**：会话里的 `counterpart.id` 是
 * `mockPublicId('usr', …)` 生成的 `usr_…`，而 fixture 的 `sellerId` 是原始键（`u-…`），
 * 直接按公开 id 过滤恒为空 —— 表现是「TA 暂无在售商品」的假空态。
 */
export function demoUserListingsByPublicId(publicUserId: string): MockListing[] {
  const raw = USERS.find((user) => mockPublicId('usr', user.id) === publicUserId)
  // 与真实端点同口径：只给在售。
  return raw ? userListings(raw.id).filter((item) => item.status === 'ACTIVE') : []
}

/**
 * 「我的宝贝」兜底（`loadMyListings`）：fixture 里「我」的在售列表。
 *
 * 演示身份（`DEMO_USER`）与 fixture 的「我」不同 ID，回退不能按 id 查。
 */
export function demoMyListings(): MockListing[] {
  return myListings().filter((item) => item.status === 'ACTIVE')
}

/* --------------------------------------------------------------- 订单 */

/** 订单列表的兜底（`loadOrders` 的 catch） */
export function demoOrderViews(role: TransactionRole): Promise<OrderView[]> {
  return fetchOrders(role)
}

/** 订单卡解析会话 id 用的兜底实现，与 `demoOrderViews` 配套 */
export function demoOpenConversation(listingId: string, counterpartId: string): string | null {
  return openConversation(listingId, counterpartId)
}

/* --------------------------------------------------------------- 个人中心 */

/**
 * 「我的」页兜底（`demoProfile`）需要的 fixture 原始块。
 *
 * 页面的演示数字（收藏 8 / 足迹 24 / 关注 5）是设计稿常量而不是 fixture，留在
 * `fetchers.ts` 的 `demoProfile()` 里，本函数只给「从 fixture 取得到的那几项」。
 */
export function demoProfileFixtures(): {
  wishes: MockWish[]
  saleCount: number
  completedCount: number
  listings: MockListing[]
  pendingMeetupSell: number
  pendingMeetupBuy: number
  orderCount: number
} {
  const wishes = myWishes()
  return {
    wishes,
    saleCount: myListingCounts().sale,
    completedCount: TRANSACTIONS.filter((tx) => tx.status === 'COMPLETED').length,
    listings: MY_LISTINGS.map((item) => item.listing),
    pendingMeetupSell: TRANSACTIONS.filter(
      (tx) => tx.role === 'seller' && tx.status === 'PENDING_MEETUP',
    ).length,
    pendingMeetupBuy: TRANSACTIONS.filter(
      (tx) => tx.role === 'buyer' && tx.status === 'PENDING_MEETUP',
    ).length,
    orderCount: TRANSACTIONS.length,
  }
}

/* --------------------------------------------------------------- 底栏 */

/** 自定义底栏未读红点的兜底（`custom-tab-bar/index.tsx`） */
export function demoTabbarUnread(): { conversations: number; notifications: number } {
  return {
    conversations: conversations()
      .filter((item) => item.kind !== 'system')
      .reduce((sum, item) => sum + item.unreadCount, 0),
    notifications: unreadNotificationCount(),
  }
}
