/**
 * `@/features/mock-fallback` 在**生产构建**下的替身。
 *
 * `apps/miniapp/config/index.ts` 在 `__ALLOW_MOCK_FALLBACK__` 为假时（即
 * `TARO_APP_MOCK !== '1'` 且 `NODE_ENV !== 'development'`）把精确路径
 * `@/features/mock-fallback` alias 到本文件，于是整包演示 fixture 根本不进生产包的
 * 模块图（`mock/catalog.ts` / `chat.ts` / `account.ts` / `users.ts` / `wishes.ts` /
 * `discover.ts` 全部消失）。
 *
 * ## 为什么是「抛错」而不是「返回空数组」
 *
 * 本文件每个函数的调用点都在 `if (!MOCK_FALLBACK_ENABLED) return …` **之后**，生产构建里
 * `MOCK_FALLBACK_ENABLED === false`，所以这些函数**不可达**。既然不可达，「返回空数组」
 * 只会把一个逻辑错误伪装成「今天没数据」的正常空态 —— 排查时看到空白页面而不是线索；
 * 抛错则让「生产里真的调到了兜底」在第一次出现时当场暴露。**这个选择不改变任何现有
 * 路径的行为**：不可达就是不执行，`TARO_APP_MOCK=1` / `NODE_ENV=development` 的演示构建
 * 走的是 `mock-fallback.ts`（alias 不生效），行为与改动前逐字一致。
 *
 * ## 纪律
 *
 * - 本文件**不得** import 任何 `@/mock/*`（连 `import type` 也不写：类型虽被擦除、
 *   不进包，但留着会让人误以为这里还依赖 fixture 的形状）。
 * - 导出的名字必须与 `mock-fallback.ts` 逐一对应，一个不漏、一个不多。
 */
import type { ListingCategory } from '@fish/contracts/listings/schema'
import type { TransactionRole } from '@fish/contracts/transactions/schema'

const DISABLED = 'mock fallback is disabled in production builds'

function disabled(call: string): never {
  throw new Error(`${call}: ${DISABLED}`)
}

/* --------------------------------------------------------------- 商品 */

export async function demoHomeFeed(category: ListingCategory | 'ALL'): Promise<never> {
  return disabled(`demoHomeFeed(${category})`)
}

export async function demoCategoryListings(category: ListingCategory): Promise<never> {
  return disabled(`demoCategoryListings(${category})`)
}

export async function demoSearchListings(keyword: string, sortLabel: string): Promise<never> {
  return disabled(`demoSearchListings(${keyword}, ${sortLabel})`)
}

export async function demoListingDetail(id: string): Promise<never> {
  return disabled(`demoListingDetail(${id})`)
}

/* --------------------------------------------------------------- 通知 / 会话 */

export function demoNotifications(): never {
  return disabled('demoNotifications()')
}

export function demoConversationFixtures(): never {
  return disabled('demoConversationFixtures()')
}

export function demoConversation(id: string): never {
  return disabled(`demoConversation(${id})`)
}

export function demoMessages(conversationId: string): never {
  return disabled(`demoMessages(${conversationId})`)
}

export function demoViewer(): never {
  return disabled('demoViewer()')
}

export function demoViewerId(): never {
  return disabled('demoViewerId()')
}

export function demoUserListingsByPublicId(publicUserId: string): never {
  return disabled(`demoUserListingsByPublicId(${publicUserId})`)
}

export function demoMyListings(): never {
  return disabled('demoMyListings()')
}

/* --------------------------------------------------------------- 订单 */

export async function demoOrderViews(role: TransactionRole): Promise<never> {
  return disabled(`demoOrderViews(${role})`)
}

export function demoOpenConversation(listingId: string, counterpartId: string): never {
  return disabled(`demoOpenConversation(${listingId}, ${counterpartId})`)
}

/* --------------------------------------------------------------- 个人中心 */

export function demoProfileFixtures(): never {
  return disabled('demoProfileFixtures()')
}

/* --------------------------------------------------------------- 底栏 */

export function demoTabbarUnread(): never {
  return disabled('demoTabbarUnread()')
}
