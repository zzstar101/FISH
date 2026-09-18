/**
 * 只读页的数据入口：**先试真实 API；只有开发 / 预览才允许退回 mock fixture**。
 *
 * ## 为什么要有这一层
 *
 * 1. 取数口径必须**一致**：哪个错误该退、哪个该报，散在 6 个页面里必然演化出 6 种口径
 *    （有的吞 401，有的吞 404，有的把网络错误也当空态）。
 * 2. 页面只该关心「拿到数据没有」，不该关心「后端在不在」。
 *
 * ## 生产口径
 *
 * mock 回退是**开发 / 预览**的便利，不是生产数据策略：API 挂掉、域名配错或契约漂移时，
 * 用户必须看到错误态，而不是一批「看起来正常」的假商品 / 假账号。因此：
 *
 * - 只有构建期注入的 `__ALLOW_MOCK_FALLBACK__ === true` 才退 mock（注入点见 `config/index.ts`）；
 *   **未注入一律当关闭** —— 这类开关必须 fail closed，否则一次构建配置疏漏就会让生产吃上假数据。
 * - 关闭时失败通过返回值的 `failed` / `status: 'failed'` 如实交给页面，由页面渲染错误态
 *   （`components/load-error`）并留日志，**不返回任何 fixture 数据**。
 * - 401 `UNAUTHENTICATED` 不是「错误」而是「未登录」：登录态由 `features/auth` 统一处理，
 *   受限页的守卫会把人送去登录页。
 *
 * ## 返回值的形状
 *
 * 一律返回**页面已经在用的视图类型**（`MockListing` / `ListingDetailView` / `MockNotification`），
 * 由 `features/listing/adapt.ts` 从契约投影过来。这样页面只改「从哪拿数据」，
 * 不动任何渲染逻辑与 CSS —— 设计稿已验收，不该为了接接口重排页面。
 *
 * **为什么不缓存**：这是取数，不是离线能力。加缓存就要引入失效策略
 * （登录后重拉、发布后失效），而当前页面每次进入都重新加载，够用。
 */
import type { Me } from '@fish/contracts/auth/user'
import type { ListingCategory, ListingSort } from '@fish/contracts/listings/schema'
import type { ProfileStats } from '@fish/contracts/profile/schema'
import { isUnauthenticatedError } from '@/lib/request'
import type { ListingDetailView } from '@/mock/api'
import type { MockListing, MockNotification, MockUser, MockWish, SearchFilter } from '@/mock/types'
import { fetchNotifications } from './chat/api'
import { toMockListing, toMockListings, toMockSeller } from './listing/adapt'
import {
  fetchCategoryListings,
  fetchHomeFeed,
  fetchListingDetail,
  fetchSimilarListings,
  searchListings,
} from './listing/api'
import { fetchProfile } from './profile/api'

/**
 * 构建期注入（`config/index.ts` 的 `defineConstants.__ALLOW_MOCK_FALLBACK__`）。
 * 本地演示 / 预览用 `TARO_APP_MOCK=1` 打开，或 H5 预览构建直接注入 `true`。
 */
declare const __ALLOW_MOCK_FALLBACK__: boolean | undefined

/** 未注入 = 关闭（fail closed），见文件头「生产口径」 */
const MOCK_FALLBACK_ENABLED = __ALLOW_MOCK_FALLBACK__ === true

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
  /** `true` = 来自真实接口；`false` = 没拿到真实数据（可能走了 mock 回退，也可能失败） */
  fromApi: boolean
  /**
   * 真实接口失败且**没有**回退 mock（生产口径）。
   * 页面据此渲染错误态：这一页是「加载不出来」，不是「恰好没有商品」。
   */
  failed: boolean
}

/** 首页 feed。真实失败：开发 / 预览退 mock，生产返回 `failed`。 */
export async function loadHomeFeed(
  category: ListingCategory | 'ALL' = 'ALL',
  now: number = Date.now(),
): Promise<LoadedList> {
  try {
    // 「推荐」= 全部：契约的 `category` 是可选枚举，没有 ALL 这个值，所以不传
    const cards = category === 'ALL' ? await fetchHomeFeed() : await fetchCategoryListings(category)
    return { items: toMockListings(cards, now), fromApi: true, failed: false }
  } catch (error) {
    reportFailure('首页 feed', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], fromApi: false, failed: true }
    const { fetchHomeFeed: mockFeed } = await import('@/mock/api')
    const result = await mockFeed({ category, limit: 40 })
    return { items: result.items, fromApi: false, failed: false }
  }
}

/**
 * 分类页：同 `loadHomeFeed` 的回退口径。带 `fromApi` / `failed`，见 `LoadedList`。
 *
 * 参数是**具体分类**而不是 `ListingCategory | 'ALL'`：分类页永远有一个选中的一级分类
 * （`pages/category/index.tsx` 的 state 就是 `ListingCategory`），
 * 留一个没人传的 `'ALL'` 分支只会变成永远走不到的死代码。「全部」由首页的 `loadHomeFeed` 负责。
 */
export async function loadCategoryListings(
  category: ListingCategory,
  sortLabel: string,
  now: number = Date.now(),
): Promise<LoadedList> {
  try {
    const cards = await fetchCategoryListings(category, toListingSort(sortLabel))
    return { items: toMockListings(cards, now), fromApi: true, failed: false }
  } catch (error) {
    reportFailure('分类列表', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], fromApi: false, failed: true }
    const { fetchCategoryListings: mockCategory } = await import('@/mock/api')
    return { items: await mockCategory(category), fromApi: false, failed: false }
  }
}

/** 搜索页：同 `loadHomeFeed` 的回退口径 */
export async function loadSearch(
  keyword: string,
  sortLabel: SearchFilter,
  now: number = Date.now(),
): Promise<LoadedList> {
  try {
    return {
      items: toMockListings(await searchListings(keyword, toListingSort(sortLabel)), now),
      fromApi: true,
      failed: false,
    }
  } catch (error) {
    reportFailure('搜索', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], fromApi: false, failed: true }
    const { searchListings: mockSearch } = await import('@/mock/api')
    // 参数类型与页面的筛选项同源（`SearchFilter`），不再用 `as never` 掩盖不匹配
    const result = await mockSearch(keyword, sortLabel)
    return { items: result.items, fromApi: false, failed: false }
  }
}

/**
 * 商品详情的加载结果。
 *
 * 三态分开是必须的：`notFound`（后端说这个商品不存在 → 空态）与 `failed`
 * （根本没问到 → 错误态）是完全不同的两件事，混成 `null` 会让页面把「后端挂了」
 * 说成「商品已下架」。
 */
export type ListingDetailResult =
  | { status: 'ok'; view: ListingDetailView }
  | { status: 'notFound' }
  | { status: 'failed' }

/**
 * 商品详情。
 *
 * 返回页面已有的 `ListingDetailView`（`listing` / `seller` / `comments` / `similar`）。
 * 真实数据下：`comments` 恒为空数组（契约没有 comments 域）、
 * `similar` 走 `GET /listings?category=` 再排掉自己（契约无相似端点，与 Web 端同做法）。
 *
 * 404（商品真的不存在）返回 `null` **且不退 mock** ——
 * 一个已删除的商品显示出一条 mock 数据，比空态更误导。
 *
 * 刻意**不**回传「这次是不是 mock」：页面没有地方用这个信息（详情页没有「你在看演示数据」
 * 这种提示位），留一个没人消费的标志只会让人以为有分支没写。需要时再加。
 */
export async function loadListingDetail(
  id: string,
  now: number = Date.now(),
): Promise<ListingDetailResult> {
  try {
    const detail = await fetchListingDetail(id)
    if (detail === null) return { status: 'notFound' }

    // 相似推荐失败不该拖垮整页：这里降级成「没有相似推荐」，但要留痕 ——
    // 静默吞掉会让契约解析漂移看起来像「这个分类恰好没有同类商品」。
    const similar = await fetchSimilarListings(detail.category, detail.id).catch((error) => {
      console.warn('[miniapp] 相似推荐获取失败，本次不展示相似商品', error)
      return []
    })
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
      status: 'ok',
      view: {
        listing,
        seller,
        // 契约没有 comments 域：真实数据下没有留言可展示，给空数组而不是编几条
        comments: [],
        similar: toMockListings(similar, now),
      },
    }
  } catch (error) {
    reportFailure('商品详情', error)
    if (!MOCK_FALLBACK_ENABLED) return { status: 'failed' }
    const { fetchListingDetail: mockDetail } = await import('@/mock/api')
    const view = await mockDetail(id)
    return view ? { status: 'ok', view } : { status: 'notFound' }
  }
}

/* --------------------------------------------------------------- 通知 */

/**
 * 通知列表。
 *
 * 文案与跳转目标由客户端按 `type` + `payload` 组装（#23：服务端不存文案），
 * 所以真实数据也要过一遍 `decorateNotification` —— 与 Web 端同口径，不重写第二份。
 */
/** 通知列表的加载结果：`failed` 时页面显示错误态而不是空态 */
export type LoadedNotifications = { items: MockNotification[]; failed: boolean }

export async function loadNotifications(): Promise<LoadedNotifications> {
  try {
    const items = await fetchNotifications()
    const { decorateNotifications } = await import('@/mock/api')
    // 传 `null`：真实通知只有 payload 里的 listingId，**没有查标题的能力**
    // （契约不返回文案，也没有按 id 批量查商品的端点）。给个「查不到」就当
    // 「已下架」是错的，所以这里只出通用文案 + 保留跳转目标。
    return { items: decorateNotifications(items, null), failed: false }
  } catch (error) {
    reportFailure('通知列表', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], failed: true }
    const { notifications: mockNotifications } = await import('@/mock/api')
    return { items: mockNotifications(), failed: false }
  }
}

/* --------------------------------------------------------------- 我的 */

/**
 * 个人中心。**任何失败都返回 `null`，绝不返回 fixture** —— 调用方（`pages/profile`）
 * 拿不到真实数据时按空值渲染，不拿演示账号顶上（演示身份会让人以为登录成了别人）。
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
    reportFailure('个人中心', error)
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
 * 失败留痕。登录态缺失与网络不可用属于预期情况（是「当前没有后端 / 没登录」，
 * 不是缺陷），因此降级为 debug；其余（含契约解析失败）用 warn ——
 * 那意味着前端与契约已经漂移，不该被静默吞掉。
 *
 * 日志里必须写明**这次有没有退 mock**：生产口径下没退，看日志的人才知道
 * 用户看到的是错误态，而不是以为「又是演示数据」。
 */
function reportFailure(what: string, error: unknown): void {
  const expected =
    isUnauthenticatedError(error) ||
    (error instanceof Error && /request:fail|network|timeout/i.test(error.message))
  const detail = error instanceof Error ? error.message : String(error)
  const tail = MOCK_FALLBACK_ENABLED
    ? '，已回退 mock（开发 / 预览口径）'
    : '，未回退 mock（生产口径）'
  if (expected) {
    console.debug(`[miniapp] ${what}：真实接口不可用${tail}（${detail}）`)
    return
  }
  console.warn(`[miniapp] ${what}：真实接口失败${tail}`, error)
}
