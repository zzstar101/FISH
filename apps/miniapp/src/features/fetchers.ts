/**
 * 只读页的数据入口：**先试真实 API，失败退回 mock**。
 *
 * 为什么要这一层而不是让 6 个页面各自 try/catch：
 * 1. 回退策略必须**一致**。哪个错误该退、哪个该抛，散在 6 个页面里必然演化出 6 种口径
 *    （有的吞 401，有的吞 404，有的把网络错误也当空态）。
 * 2. 页面只该关心「拿到数据没有」，不该关心「后端在不在」。
 *
 * ## 返回值的形状
 *
 * 一律返回**页面已经在用的视图类型**（`MockListing` / `ListingDetailView` / `MockNotification`），
 * 由 `features/listing/adapt.ts` 从契约投影过来。这样页面只改「从哪拿数据」，
 * 不动任何渲染逻辑与 CSS —— 设计稿已验收，不该为了接接口重排页面。
 *
 * ## 回退口径（统一在这里）
 *
 * - 未登录（401 `UNAUTHENTICATED`）：正常情况（用户没登录），静默退 mock。
 * - 网络失败 / 后端未起：退 mock。小程序没有后端时也要能跑起来评审与截图。
 * - 其它错误（含 schema 解析失败）：退 mock，但用 `console.warn` 留痕 ——
 *   解析失败说明前端与契约已经漂移，静默吞掉会让这种漂移永远发现不了。
 *
 * **为什么不缓存**：这是演示期的回退，不是离线能力。加缓存就要引入失效策略
 * （登录后重拉、发布后失效），而当前页面每次进入都重新加载，够用。
 */
import type { Me } from '@fish/contracts/auth/user'
import type { ListingCategory, ListingSort } from '@fish/contracts/listings/schema'
import type { ProfileStats } from '@fish/contracts/profile/schema'
import { isUnauthenticatedError } from '@/lib/request'
import type { ListingDetailView } from '@/mock/api'
import type { MockListing, MockNotification, MockUser, MockWish } from '@/mock/types'
import { fetchNotifications } from './chat/api'
import { toMockListing, toMockListings, toMockSeller } from './listing/adapt'
import {
  fetchCategoryListings,
  fetchFeed,
  fetchHomeFeed,
  fetchListingDetail,
  fetchSimilarListings,
  searchListings,
} from './listing/api'
import { fetchProfile } from './profile/api'

/* ------------------------------------------------------------------ 排序 */

/**
 * 设计稿的筛选项 → 契约的排序枚举。两套不是同一组值，必须显式映射。
 *
 * 「综合」与「成色」契约里**没有**对应排序（后端无热度字段、成色不是排序键），
 * 因此退到 `newest`。这是真实能力的边界，不是 bug —— 页面上的这两个筛选
 * 在接真接口后等价于「最新」，由 PR 描述记录，不假装支持。
 */
export function toListingSort(label: string): ListingSort {
  if (label === '价格') return 'priceAsc'
  return 'newest'
}

/* ------------------------------------------------------------------ 商品 */

/**
 * 列表加载结果。
 *
 * `fromApi` 不只是日志信息：**页面需要它来决定哪些展示件是诚实的**。
 * 契约的 `ListingCard` 没有二级分类、也没有「本分类共 N 件」这类统计，
 * 而 mock fixture 有。页面拿真实数据时若继续渲染那些来自 fixture 的件，
 * 就会出现「真商品 + 假计数」或「二级筛选把整页筛空」——两者都在本次审查中被抓到。
 * 所以把来源显式交给页面，由页面决定隐藏哪些件。
 */
export type LoadedList = {
  items: MockListing[]
  /** `true` = 来自真实接口；`false` = 走了 mock 回退 */
  fromApi: boolean
}

/** 首页 feed。真实失败退 mock 首页 feed。 */
export async function loadHomeFeed(
  category: ListingCategory | 'ALL' = 'ALL',
  now: number = Date.now(),
): Promise<MockListing[]> {
  try {
    // 「推荐」= 全部：契约的 `category` 是可选枚举，没有 ALL 这个值，所以不传
    const cards = category === 'ALL' ? await fetchHomeFeed() : await fetchCategoryListings(category)
    return toMockListings(cards, now)
  } catch (error) {
    warnFallback('首页 feed', error)
    const { fetchHomeFeed: mockFeed } = await import('@/mock/api')
    const result = await mockFeed({ category, limit: 40 })
    return result.items
  }
}

/** 分类页：真实失败退 mock 分类列表。带 `fromApi`，见 `LoadedList`。 */
export async function loadCategoryListings(
  category: ListingCategory | 'ALL',
  sortLabel: string,
  now: number = Date.now(),
): Promise<LoadedList> {
  try {
    const sort = toListingSort(sortLabel)
    const cards =
      category === 'ALL'
        ? (await fetchFeed({ sort })).items
        : await fetchCategoryListings(category, sort)
    return { items: toMockListings(cards, now), fromApi: true }
  } catch (error) {
    warnFallback('分类列表', error)
    const { fetchCategoryListings: mockCategory } = await import('@/mock/api')
    return { items: await mockCategory(category), fromApi: false }
  }
}

/** 搜索页：真实失败退 mock 搜索 */
export async function loadSearch(
  keyword: string,
  sortLabel: string,
  now: number = Date.now(),
): Promise<MockListing[]> {
  try {
    return toMockListings(await searchListings(keyword, toListingSort(sortLabel)), now)
  } catch (error) {
    warnFallback('搜索', error)
    const { searchListings: mockSearch } = await import('@/mock/api')
    const result = await mockSearch(keyword, sortLabel as never)
    return result.items
  }
}

/**
 * 商品详情。
 *
 * 返回页面已有的 `ListingDetailView`（`listing` / `seller` / `comments` / `similar` / `commentTotal`）。
 * 真实数据下：`comments` 恒为空数组（契约没有 comments 域）、`commentTotal` 为 0、
 * `similar` 走 `GET /listings?category=` 再排掉自己（契约无相似端点，与 Web 端同做法）。
 *
 * 404（商品真的不存在）返回 `{ view: null }` **且不退 mock** ——
 * 一个已删除的商品显示出一条 mock 数据，比空态更误导。
 */
export async function loadListingDetail(
  id: string,
  now: number = Date.now(),
): Promise<{ view: ListingDetailView | null; fromMock: boolean }> {
  try {
    const detail = await fetchListingDetail(id)
    if (detail === null) return { view: null, fromMock: false }

    const similar = await fetchSimilarListings(detail.category, detail.id).catch(() => [])
    const seller: MockUser = toMockSeller(detail)
    // 先按列表卡投影一次拿到公共字段（角标 / 比例 / 相对时间），再补详情独有的几项。
    // 不用 `[0]!`：空数组断言会掩盖投影层的 bug，这里显式兜底。
    const [base] = toMockListings([detail], now)
    const listing: MockListing = {
      ...(base ?? toMockListing(detail, now)),
      // 详情比列表卡多这几项，契约里都有
      description: detail.description,
      images: detail.images.map((image) => image.url),
      // 契约允许无图：优先封面，其次图集首图，都没有才留空由页面占位
      coverUrl: detail.coverUrl ?? detail.images[0]?.url ?? '',
      sellerId: seller.id,
    }

    return {
      view: {
        listing,
        seller,
        // 契约没有 comments 域：真实数据下没有留言可展示，给空数组而不是编几条
        comments: [],
        similar: toMockListings(similar, now),
        commentTotal: 0,
      },
      fromMock: false,
    }
  } catch (error) {
    warnFallback('商品详情', error)
    const { fetchListingDetail: mockDetail } = await import('@/mock/api')
    return { view: await mockDetail(id), fromMock: true }
  }
}

/* --------------------------------------------------------------- 通知 */

/**
 * 通知列表。
 *
 * 文案与跳转目标由客户端按 `type` + `payload` 组装（#23：服务端不存文案），
 * 所以真实数据也要过一遍 `decorateNotification` —— 与 Web 端同口径，不重写第二份。
 */
export async function loadNotifications(): Promise<MockNotification[]> {
  try {
    const items = await fetchNotifications()
    const { decorateNotifications } = await import('@/mock/api')
    // 传 `null`：真实通知只有 payload 里的 listingId，**没有查标题的能力**
    // （契约不返回文案，也没有按 id 批量查商品的端点）。给个「查不到」就当
    // 「已下架」是错的，所以这里只出通用文案 + 保留跳转目标。
    return decorateNotifications(items, null)
  } catch (error) {
    warnFallback('通知列表', error)
    const { notifications: mockNotifications } = await import('@/mock/api')
    return mockNotifications()
  }
}

/* --------------------------------------------------------------- 我的 */

/**
 * 个人中心。真实失败返回 `null`，由页面退回 mock 的同步统计。
 *
 * 返回值刻意是「页面需要的那几块」而不是整个 `ProfileResponse`：
 * 页面用的是 `stats` + 商品卡 + 愿望行 + 订单计数，契约的 `transactions` 原始数组
 * 页面并不直接渲染（`orderOverview()` 只取计数），所以在这里就地折算。
 */
export type ProfileView = {
  user: Me
  stats: ProfileStats
  listings: MockListing[]
  wishes: MockWish[]
  /** 待面交笔数（设计稿「待面交 N」入口文案） */
  pendingMeetup: number
  /** 全部买卖笔数 */
  orderCount: number
}

export async function loadProfile(now: number = Date.now()): Promise<ProfileView | null> {
  try {
    const profile = await fetchProfile()
    return {
      user: profile.user,
      stats: profile.stats,
      listings: toMockListings(profile.listings, now),
      wishes: profile.wishes.map(toMockWish),
      pendingMeetup: profile.transactions.filter((tx) => tx.status === 'PENDING_MEETUP').length,
      orderCount: profile.transactions.length,
    }
  } catch (error) {
    warnFallback('个人中心', error)
    return null
  }
}

/**
 * `WishDto` → `MockWish`。
 *
 * 契约没有 `campus` / `timeLabel`（那是 mock 的展示字段），因此：
 * `campus` 置 `null`、`timeLabel` 由契约的 `createdAt` 相对时间算出来。
 * 页面已做 null 守卫，不会显示「null校区」。
 */
function toMockWish(wish: {
  id: string
  keyword: string
  category: MockWish['category']
  budgetMinCents: number
  budgetMaxCents: number
  description: string | null
  acceptSimilar: boolean
  status: MockWish['status']
  matchCount: number
  createdAt: string
}): MockWish {
  return {
    id: wish.id,
    userId: '',
    keyword: wish.keyword,
    category: wish.category,
    budgetMinCents: wish.budgetMinCents,
    budgetMaxCents: wish.budgetMaxCents,
    description: wish.description,
    acceptSimilar: wish.acceptSimilar,
    status: wish.status,
    matchCount: wish.matchCount,
    createdAt: wish.createdAt,
    // 契约无校区：不编一个
    campus: null,
    // 相对时间由契约的 createdAt 现算
    timeLabel: relativeLabel(wish.createdAt),
  }
}

/** 相对时间文案（与 `lib/format.ts` 同口径，但这里的「刚刚/N 天前」是列表行文案） */
function relativeLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const hours = Math.max(0, (now - at) / 3600000)
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))} 分钟前`
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 供页面把契约 `ListingCard[]` 直接转成卡片视图（详情页相似推荐等） */
export { toMockListings }

/* --------------------------------------------------------------- 内部 */

/**
 * 回退时留痕。登录态缺失与网络不可用属于预期情况（是「当前没有后端/没登录」，
 * 不是缺陷），因此降级为 debug；其余（含契约解析失败）用 warn ——
 * 那意味着前端与契约已经漂移，不该被静默吞掉。
 */
function warnFallback(what: string, error: unknown): void {
  const expected =
    isUnauthenticatedError(error) ||
    (error instanceof Error && /request:fail|network|timeout/i.test(error.message))
  const detail = error instanceof Error ? error.message : String(error)
  if (expected) {
    console.debug(`[miniapp] ${what}：真实接口不可用，已回退 mock（${detail}）`)
    return
  }
  console.warn(`[miniapp] ${what}：真实接口失败，已回退 mock`, error)
}
