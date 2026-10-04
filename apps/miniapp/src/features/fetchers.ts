/**
 * 页面数据入口（含通知的逐条已读**回写**）：**先试真实 API；只有开发 / 预览才允许退回 mock fixture**。
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
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { ListingCategory, ListingSort } from '@fish/contracts/listings/schema'
import type { ProfileStats } from '@fish/contracts/profile/schema'
import type { TransactionRole } from '@fish/contracts/transactions/schema'
import type { PublicUserProfile, UserPresence } from '@fish/contracts/users/schema'
import { DEMO_AUTH_ENABLED, DEMO_USER } from '@/features/auth/demo'
// 必须写成 `@/features/mock-fallback` 这个**绝对**说明符：生产构建靠 config/index.ts 里
// 同名 alias 把它换成不 import `@/mock/*` 的 prod 桩；改成相对路径会让 alias 失配、
// 整包 fixture 重新回到首屏图（见 config/index.ts 的 alias 注释）。
import {
  demoCategoryListings,
  demoConversation,
  demoConversationFixtures,
  demoHomeFeed,
  demoListingDetail,
  demoMessages,
  demoMyListings,
  demoNotifications,
  demoOpenConversation,
  demoOrderViews,
  demoProfileFixtures,
  demoSearchListings,
  demoUserListingsByPublicId,
  demoViewer,
  demoViewerId,
} from '@/features/mock-fallback'
import { decorateNotifications } from '@/features/notifications/decorate'
import { isApiError } from '@/lib/request'
import type { ListingDetailView } from '@/mock/api'
import type {
  MockConversation,
  MockListing,
  MockMessage,
  MockNotification,
  MockUser,
  MockWish,
  SearchFilter,
} from '@/mock/types'
import {
  fetchConversation,
  fetchConversationPage,
  fetchMessagePage,
  fetchNotifications,
  markNotificationRead,
} from './chat/api'
import { mergeMarkReadResults } from './chat/notif-read'
import { fetchMyFavoritesTotal } from './favorites/api'
import { toMockListing, toMockListings, toMockSeller } from './listing/adapt'
import {
  fetchCategoryListings,
  fetchListingDetail,
  fetchSimilarListings,
  searchListings,
} from './listing/api'
import { MOCK_FALLBACK_ENABLED, reportFailure } from './load-failure'
import { fetchProfile } from './profile/api'
import { type OrderCardView, toOrderCard, toOrderCardFromMock } from './transaction/adapt'
import { fetchAllTransactions } from './transaction/api'
import { fetchPublicUserListings, fetchPublicUserProfile } from './user/api'
import { toMockWish } from './wish/adapt'

/**
 * 演示兜底开关与失败留痕已挪到 `features/load-failure.ts`（愿望/匹配的取数模块也要用，
 * 但不该跟着静态 import 会话域）。这里原样 re-export，`@/features/fetchers` 的既有调用方不变。
 */
export { MOCK_FALLBACK_ENABLED }

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
  /**
   * 本次推荐请求的 id（`GET /recommendations/feed` 的 `requestId`）。
   *
   * 分类列表、以及退 mock 的开发/预览都没有推荐请求上下文 → `null`：此时**不发**
   * IMPRESSION / QUICK_SKIP，因为契约强制这两个事件必须带 requestId（见 `recommendation/schema.ts`），
   * 没有归因就发等于制造必然被拒的事件。
   */
  requestId?: string | null
  /**
   * 公开 id → 本次推荐请求内的全局 `position`。
   *
   * 序号按**服务端那一份 feed 的原始下标**算：页面按本地隐藏名单过滤展示件时不能重新编号，
   * 否则归因会整体错位（服务端看到的 position 与它下发的那条不一致）。
   */
  positions?: Map<string, number>
}

/** 首页 feed。「推荐」走推荐端点，分类走商品列表；真实失败：开发 / 预览退 mock，生产返回 `failed`。 */
export async function loadHomeFeed(
  category: ListingCategory | 'ALL' = 'ALL',
  now: number = Date.now(),
): Promise<LoadedList> {
  try {
    if (category === 'ALL') {
      /*
        首页的「推荐」改走 `GET /recommendations/feed`（R1）：它比 `GET /listings` 多给出
        `requestId` 与 `strategyVersion`，曝光与详情归因都要挂在这个 requestId 上。
        排序语义不变（R1 服务端透传 newest），所以对用户来说还是同一批商品。

        **必须惰性 import**：`features/recommendation/*` 静态依赖 `@tarojs/taro`（会话标识存在
        小程序存储里），而本文件被测试动态 import 时 `@/lib/request` 是被 mock 掉的、Taro 运行时
        并不会被求值。顶层静态引入会把 Taro 拖进模块图，让这些用例在 `bun test` 下直接
        `ReferenceError: ENABLE_INNER_HTML is not defined`（与 `@/mock/api` 同一套做法）。
      */
      const { fetchRecommendationFeed } = await import('@/features/recommendation/api')
      const feed = await fetchRecommendationFeed()
      return {
        items: toMockListings(feed.items, now),
        fromApi: true,
        failed: false,
        requestId: feed.requestId,
        positions: new Map(feed.items.map((card, index): [string, number] => [card.id, index])),
      }
    }
    // 其余分类仍是确定性商品查询：契约的 `category` 是可选枚举，没有 ALL 这个值，所以不传
    const cards = await fetchCategoryListings(category)
    return { items: toMockListings(cards, now), fromApi: true, failed: false }
  } catch (error) {
    reportFailure('首页 feed', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], fromApi: false, failed: true }
    // 退 mock 没有服务端 requestId → 显式置 null，页面据此跳过曝光类事件
    return {
      items: await demoHomeFeed(category),
      fromApi: false,
      failed: false,
      requestId: null,
      positions: new Map(),
    }
  }
}

/**
 * 分类列表：同 `loadHomeFeed` 的回退口径。带 `fromApi` / `failed`，见 `LoadedList`。
 *
 * 调用方是**首页的分类筛选**（`pages/home` 的 `category` 状态）：选中某个具体分类就地取数，
 * 与「推荐」共用首页顶栏与底栏。参数是**具体分类**而不是 `ListingCategory | 'ALL'`：
 * 选中项一定是一个具体分类，「推荐」（= 全部）由 `loadHomeFeed` 负责，
 * 留一个没人传的 `'ALL'` 分支只会变成永远走不到的死代码。
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
    return { items: await demoCategoryListings(category), fromApi: false, failed: false }
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
    // 参数类型与页面的筛选项同源（`SearchFilter`），不再用 `as never` 掩盖不匹配
    return { items: await demoSearchListings(keyword, sortLabel), fromApi: false, failed: false }
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
 * 真实数据下：`comments` 恒为空数组 —— 留言走独立端点
 * （`features/listing/comments.ts` 的 `fetchComments`，Issue #111），由详情页并行加载；
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

    // 相似推荐与卖家公开资料**并行**取，两件都不该拖垮整页：
    // 失败降级成「没有相似推荐 / 不展示卖出件数」，但要留痕 —— 静默吞掉会让契约解析漂移
    // 看起来像「这个分类恰好没有同类商品」或「这个卖家恰好没卖过东西」。
    //
    // 卖家公开资料一次拿两样：卖出件数，以及在线态（#359 第五点，详情页卖家行要显示）。
    // 认证状态**不**从这里取：详情响应本身就带真值，不必多一次请求去问同一件事。
    const [similar, sellerProfile] = await Promise.all([
      fetchSimilarListings(detail.category, detail.id).catch((error) => {
        console.warn('[miniapp] 相似推荐获取失败，本次不展示相似商品', error)
        return []
      }),
      fetchPublicUserProfile(detail.seller.id).catch((error) => {
        console.warn('[miniapp] 卖家公开资料获取失败，本次不展示卖出件数与在线态', error)
        return null
      }),
    ])
    const seller: MockUser = toMockSeller(
      detail,
      sellerProfile?.soldCount ?? null,
      sellerProfile?.presence ?? null,
    )
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
        // 留言不在这里取（#111 的 GET /listings/:id/comments 由详情页调用）：
        // 真实数据下给空数组，只有退 mock 时才带上 fixture。
        comments: [],
        similar: toMockListings(similar, now),
      },
    }
  } catch (error) {
    reportFailure('商品详情', error)
    if (!MOCK_FALLBACK_ENABLED) return { status: 'failed' }
    const view = await demoListingDetail(id)
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
    // 传 `null`：真实通知只有 payload 里的 listingId，**没有查标题的能力**
    // （契约不返回文案，也没有按 id 批量查商品的端点）。给个「查不到」就当
    // 「已下架」是错的，所以这里只出通用文案 + 保留跳转目标。
    return { items: decorateNotifications(items, null), failed: false }
  } catch (error) {
    reportFailure('通知列表', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], failed: true }
    return { items: demoNotifications(), failed: false }
  }
}

/**
 * 把给出的未读通知逐条真实标记已读（#431 任务二：**逐条点击**才置读，
 * 不再是「切进通知 tab 即整表已读」）。
 *
 * 只对调用方给出的条目逐条调幂等 `POST /notifications/:id/read` —— 契约没有
 * mark-all-read 端点，客户端不假设有。返回**标记成功**的 id 集合：调用方（chat 页）
 * 先乐观置读，拿到这里的结果后只对**未成功**的条目回滚成未读。
 *
 * 演示 / 开发构建（`MOCK_FALLBACK_ENABLED`）的兜底口径见 `mergeMarkReadResults`：
 * 只有**整批都因后端不可达而失败**才按演示口径视为全部已读，真实的接口错误
 * （401 / 404 / 5xx）一律如实返回。
 */
export async function markNotificationsRead(items: MockNotification[]): Promise<Set<string>> {
  if (items.length === 0) return new Set()
  const results = await Promise.allSettled(items.map((item) => markNotificationRead(item.id)))
  const { ok, firstError, demoFallbackApplied } = mergeMarkReadResults(
    items.map((item) => item.id),
    results,
    MOCK_FALLBACK_ENABLED,
  )
  if (firstError !== null) reportFailure('通知标记已读', firstError, demoFallbackApplied)
  return ok
}

/* --------------------------------------------------------------- 会话 */

/** 会话列表一页的加载结果：`failed` 时页面显示错误态而不是空态 */
export type LoadedConversations = {
  items: ConversationDto[]
  /** null = 已到最后一页 */
  nextCursor: string | null
  failed: boolean
}

/**
 * 会话列表（#89：Chat 页不再从 fixture 读会话）。`cursor` 传上一页的 `nextCursor`。
 *
 * 与通知列表同一口径：真实接口优先；只有演示 / 开发构建（`MOCK_FALLBACK_ENABLED`，
 * 本地没有后端）才退回 fixture，生产失败如实返回 `failed: true` 由页面显示错误态 +
 * 重试，**不拿 fixture 顶替** —— 假会话比错误态更糟。
 */
export async function loadConversations(cursor?: string): Promise<LoadedConversations> {
  try {
    const page = await fetchConversationPage(cursor)
    return { items: page.items, nextCursor: page.nextCursor, failed: false }
  } catch (error) {
    reportFailure('会话列表', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], nextCursor: null, failed: true }
    const { items, viewerId } = demoConversationFixtures()
    return {
      /**
       * fixture 里的「系统会话」（`kind === 'system'`）是契约外的展示扩展：它不是
       * (商品, 买家×卖家) 的会话，`counterpart` 就是当前用户自己。本轮已按 Owner
       * 决策删掉系统会话行 —— 兜底里不滤掉它，就会在演示构建里以「和自己聊天的
       * 会话行」复活，而且与底栏兜底的口径分叉。
       *
       * 过滤已在 `demoConversationFixtures` 里做掉（底栏红点同一口径）。
       */
      items: items.map((item) => toConversationDto(item, viewerId, null)),
      // fixture 没有分页
      nextCursor: null,
      failed: false,
    }
  }
}

/**
 * 演示构建的 fixture 形状 → 契约 DTO。
 *
 * `MockConversation` 是「契约字段 + mock 专属展示字段」（`kind` / `tag` / `timeLabel` /
 * `mediaPreview`…），但**缺** `listingId` / `createdAt` / `counterpartLastReadAt` 三项，
 * 所以要显式补齐而不是直接断言成 `ConversationDto`（断言的失败方式是运行期拿到
 * `undefined`，而不是编译期报错）。
 */
/**
 * 演示构建的「对方在线态」（#359 第五点，Owner 决策）。
 *
 * fixture 里没有活动登记表这个事实，但**不能**给 `{ online: false, lastActiveAt: null }`
 * —— 那是**权威的「离线」**（服务端答了、只是没有活动记录；真实链路上必须如实渲染），
 * 演示里会让每个会话恒显「离线」，微信开发者工具的门禁看不到在线档。这里按会话 id
 * 稳定地分两档：一半「在线」、一半「12 分钟前活跃」，两档都能在端上看到。
 *
 * 时刻一律**相对当下**算，不写固定时间戳：固定值会随时间漂成假话（写死的「5 分钟前
 * 活跃」过两天就是谎话）。在线档给 30s 前的活动，落在 `PRESENCE_ONLINE_TTL_MS` 窗口内。
 *
 * 注意「拿不到」是另一回事 —— 那是 `null`，由端上整块不渲染（见 `features/presence/view`）。
 */
function demoCounterpartPresence(seed: string): UserPresence {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  const now = Date.now()
  return hash % 2 === 0
    ? { online: true, lastActiveAt: new Date(now - 30_000).toISOString() }
    : { online: false, lastActiveAt: new Date(now - 12 * 60_000).toISOString() }
}

function toConversationDto(
  item: MockConversation,
  mockViewerId: Me['id'],
  counterpartLastReadAt: string | null,
): ConversationDto {
  // 演示登录与 fixture 的「我」使用不同 ID；摘要必须与历史消息的 senderId 同步投影。
  const lastMessage = item.lastMessage
  return {
    id: item.id,
    listingId: item.listing.id,
    role: item.role,
    listing: item.listing,
    // 多出来的 mock 专属 authStatus 结构上可赋给 ConversationUser，不需要逐字段重建
    counterpart: item.counterpart,
    unreadCount: item.unreadCount,
    /*
      读位由调用方给（#359 四 审查回合）：列表行不显示逐条已读标签，给 null 即可；
      详情回退要用 `demoCounterpartLastReadAt` 从 fixture 的消息流里算一个确定性的值 ——
      全给 null 的话演示构建里**每条**我发的消息都是红「未读」，「已读」这一档在端上
      根本看不到，而端上门禁要求在开发者工具里逐页演示这个标签。
    */
    counterpartLastReadAt,
    // 在线态（#359 第五点）：fixture 没有可投影的事实，走演示专用的稳定样值。
    counterpartPresence: demoCounterpartPresence(item.id),
    lastMessage:
      DEMO_AUTH_ENABLED && lastMessage?.senderId === mockViewerId
        ? { ...lastMessage, senderId: DEMO_USER.id }
        : lastMessage,
    lastMessageAt: item.lastMessageAt,
    createdAt: item.lastMessageAt,
  }
}

/** 会话详情：`missing`（真的没这条会话）与 `failed`（没读到）必须分开 */
export type LoadedConversation =
  | { status: 'ok'; conversation: ConversationDto }
  | { status: 'missing' }
  | { status: 'failed' }

export async function loadConversation(conversationId: string): Promise<LoadedConversation> {
  try {
    return { status: 'ok', conversation: await fetchConversation(conversationId) }
  } catch (error) {
    // 404 CONVERSATION_NOT_FOUND：不存在，或查看者不是参与者（服务端刻意不区分，不泄漏存在性）
    if (isApiError(error) && error.code === 'CONVERSATION_NOT_FOUND') return { status: 'missing' }
    reportFailure('会话详情', error)
    if (!MOCK_FALLBACK_ENABLED) return { status: 'failed' }
    const found = demoConversation(conversationId)
    if (!found) return { status: 'missing' }
    /*
      详情回退顺手把「对方读位」算出来（#359 四 审查回合）：读位是逐条已读标签唯一的
      数据来源，fixture 里没有这个事实 —— 不补的话演示构建全屏红字、看不到「已读」。
      取值口径见 `demoCounterpartLastReadAt`（fixture 没有分页，一份消息就够）。
    */
    return {
      status: 'ok',
      conversation: toConversationDto(
        found,
        demoViewerId(),
        demoCounterpartLastReadAt(demoMessages(conversationId), found.counterpart.id),
      ),
    }
  }
}

/**
 * 演示构建的「对方读位」（#359 四 审查回合）。
 *
 * fixture 里没有「对方读到哪」这个事实，原先一律给 `null` —— 于是演示构建里**每条**我发的
 * 消息都是红「未读」，「已读」这一档在端上根本看不到，而端上门禁要求在微信开发者工具里
 * 逐页演示这个标签。
 *
 * 这里取「**倒数第二条**自己发的消息」时刻：最后一条自己发的因此落在读位之后显示「未读」，
 * 更早的都显示「已读」—— 一次演示两种状态都能看到。取的是 fixture 自己的时间（不掺
 * `Date.now()`），所以同一份数据每次进来都一样。
 */
export function demoCounterpartLastReadAt(
  items: readonly MockMessage[],
  counterpartPublicId: string,
): string | null {
  const mine = items.filter(
    (item) => item.senderId !== null && item.senderId !== counterpartPublicId,
  )
  const secondLast = mine.length >= 2 ? mine[mine.length - 2] : undefined
  return secondLast?.createdAt ?? null
}

/** 一页历史消息的加载结果：`nextCursor === null` 表示已到最早一页 */
export type LoadedMessagePage = {
  items: MessageDto[]
  nextCursor: string | null
  failed: boolean
}

export async function loadMessagePage(
  conversationId: string,
  before?: string,
): Promise<LoadedMessagePage> {
  try {
    const page = await fetchMessagePage(conversationId, before)
    return { items: page.items, nextCursor: page.nextCursor, failed: false }
  } catch (error) {
    reportFailure('消息历史', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], nextCursor: null, failed: true }
    if (before) {
      /**
       * 演示构建回落时 fixture 里**没有分页**，所以「更早一页」无从给出。
       *
       * 这里必须报 `failed: true` 而不是 `failed: false, nextCursor: null` ——
       * 后者是在断言「已经到最早一页了」，而事实是「这一页没读到」；混装场景
       * （首屏走真实接口拿到游标、更早一页请求失败落到这里）下会静默抽掉翻页入口，
       * 用户既看不到更早的消息、也看不到任何错误。
       */
      return { items: [], nextCursor: null, failed: true }
    }
    const found = demoConversation(conversationId)
    if (!found) return { items: [], nextCursor: null, failed: false }
    /**
     * fixture 的「我」是 mock 的 `ME`（u-alan），而演示构建里当前登录身份是
     * `DEMO_USER`。契约的 `senderId` 决定气泡画在左边还是右边，所以要把非对方的
     * 发送者对齐到当前身份，否则 fixture 里「我」发的消息会画到对方那一侧。
     */
    const viewer = DEMO_AUTH_ENABLED ? DEMO_USER : { ...demoViewer(), id: demoViewerId() }
    const rows = demoMessages(conversationId)
    return {
      // 传整份 fixture：引用摘引要在同一批里找被引用那条（#359 3c）
      items: rows.map((item) => toMessageDto(item, found, viewer, rows)),
      nextCursor: null,
      failed: false,
    }
  }
}

/* ------------------------------------------------ 发送商品选择页（#359） */

/** 发送商品选择页某一侧（我的 / TA 的）在售商品的加载结果 */
export type LoadedListingCandidates = {
  items: MockListing[]
  failed: boolean
  /** 服务端还有下一页：本页不做无限滚动，只用来如实提示「只展示了前 N 件」 */
  hasMore: boolean
}

async function loadListingCandidates(
  userId: string,
  demoFallback: () => Promise<MockListing[]>,
): Promise<LoadedListingCandidates> {
  try {
    const page = await fetchPublicUserListings(userId)
    // 404（用户不存在）按失败处理：会话对方的用户必然存在，走到这里只可能是环境/网络问题。
    if (page === null) return { items: [], failed: true, hasMore: false }
    return { items: toMockListings(page.items), failed: false, hasMore: page.nextCursor !== null }
  } catch (error) {
    reportFailure('发送商品选择页', error, MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED)
    if (!MOCK_FALLBACK_ENABLED || !DEMO_AUTH_ENABLED) {
      return { items: [], failed: true, hasMore: false }
    }
    // 回退是整份 fixture，没有「下一页」这回事。
    return { items: await demoFallback(), failed: false, hasMore: false }
  }
}

/**
 * 「TA的宝贝」tab：对方卖家的在售商品（与 他人主页/发送页 同一公开读端点）。
 *
 * 演示回退必须先把**公开 id 反查回 fixture 键**：会话里的 `counterpart.id` 是
 * `mockPublicId('usr', …)` 生成的 `usr_…`，而 fixture 的 `sellerId` 是原始键（`u-…`），
 * 直接按公开 id 过滤恒为空 —— 表现是「TA 暂无在售商品」的假空态，而初始 tab 恰好是这一侧
 * （买家进页面默认看对方）。`mock/users.ts` 的 `getUser` 是同一套反查。
 */
export function loadCounterpartListings(userId: string): Promise<LoadedListingCandidates> {
  return loadListingCandidates(userId, async () => demoUserListingsByPublicId(userId))
}

/**
 * 「我的宝贝」tab：我在售的商品。
 * 演示身份（`DEMO_USER`）与 fixture 的「我」不同 ID，回退不能按 id 查——直接取
 * fixture 里「我」的在售列表（与会话详情回退把 viewer 投影成当前身份的同一取舍）。
 */
export function loadMyListings(meId: string): Promise<LoadedListingCandidates> {
  return loadListingCandidates(meId, async () => demoMyListings())
}

/** 消息发送者需要的最小面（`Me` 与 `MockUser` 都满足） */
type ViewerLike = { id: Me['id']; nickname: string; avatarUrl: string | null }

/**
 * 演示构建的 fixture 消息 → 契约 `MessageDto`。
 *
 * 契约对 TEXT 有联合完整性约束（`senderId` 与 `sender` 都必须非空，
 * `messageDtoSchema` 的 refine 同源），而 fixture 只存 `senderId`，
 * 所以要按「这条是不是对方发的」补出 `sender`。`senderId` 也要一起对齐到
 * `viewer`（见调用点的说明）。
 *
 * #359 3c：`replyTo` 与 `recalledAt` 同样按契约语义补出来 —— 撤回的消息正文清空
 * （服务端也不下发），引用则按 `replyToId` 从同一份 fixture 里合成摘引。
 */
function toMessageDto(
  item: MockMessage,
  conversation: MockConversation,
  viewer: ViewerLike,
  all: readonly MockMessage[] = [],
): MessageDto {
  const fromCounterpart = item.senderId !== null && item.senderId === conversation.counterpart.id
  const senderId = item.senderId === null ? null : fromCounterpart ? item.senderId : viewer.id
  const sender =
    senderId === null
      ? null
      : fromCounterpart
        ? {
            id: conversation.counterpart.id,
            nickname: conversation.counterpart.nickname,
            avatarUrl: conversation.counterpart.avatarUrl,
          }
        : { id: viewer.id, nickname: viewer.nickname, avatarUrl: viewer.avatarUrl }
  /**
   * #359 3c：被引用那条在本会话里的投影（用于合成摘引）。只在这里用，不递归 ——
   * 被引用消息自己的 `replyTo` 恒为空，避免「引用链」在演示数据里无限展开。
   */
  const replied = item.replyToId
    ? all.find((candidate) => candidate.id === item.replyToId)
    : undefined
  const replyTo = replied
    ? {
        id: replied.id,
        senderId:
          replied.senderId === null
            ? null
            : replied.senderId === conversation.counterpart.id
              ? conversation.counterpart.id
              : viewer.id,
        excerpt: toReplyExcerpt(replied),
      }
    : null
  return {
    id: item.id,
    conversationId: item.conversationId,
    senderId,
    sender,
    type: item.type,
    // 撤回后正文不再下发（服务端同口径）：演示态也清空，两档画同一个撤回碑。
    content: item.recalled ? '' : item.content,
    // fixture 没有「撤回时刻」这个概念，用占位时间戳表达「已撤回」这一个事实
    recalledAt: item.recalled ? item.createdAt : null,
    // 演示 fixture 不做商品卡投射（富化只在服务端），与契约的可选字段一致
    listing: null,
    replyTo,
    createdAt: item.createdAt,
  }
}

/**
 * 演示消息的摘引文案。口径与服务端 `replyExcerpt`
 * （`apps/api/src/modules/messages/reply.ts`）一致：已撤回 `[消息已撤回]`、
 * 空文本 `[消息]`、超长截断到 120 字含省略号。
 */
function toReplyExcerpt(item: MockMessage): string {
  if (item.recalled) return '[消息已撤回]'
  const text = item.content.trim()
  if (text.length === 0) return '[消息]'
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/* --------------------------------------------------------------- 订单 */

/**
 * 订单列表的加载结果。
 *
 * `truncated` 必须显式交给页面：契约没有 `total`，而页面上的统计行、筛选胶囊计数与
 * 「已经到底了」都建立在「这份列表就是全部」之上。**列表不完整时**（翻页到上限，或
 * 服务端游标没有前进）页面不显示那些由总数派生的文案 —— 而不是把不完整的数据说成全部。
 */
export type LoadedOrders = {
  items: OrderCardView[]
  /** 真实接口失败且**没有**回退 mock（生产口径）→ 页面渲染错误态而不是空态 */
  failed: boolean
  truncated: boolean
}

/**
 * 我的订单（按视角，供 `pages/orders-buy` 与 `pages/orders-sell` 共用）。
 *
 * 一次取完该视角下的全部交易（`fetchAllTransactions` 的游标翻页），原因见那里的说明：
 * 本页的计数与「到底了」是派生值，只有完整集合才诚实。
 *
 * 契约的 `TransactionDto` 已经内嵌了商品摘要与对方摘要，所以这里不需要任何回查。
 */
export async function loadOrders(role: TransactionRole): Promise<LoadedOrders> {
  try {
    const page = await fetchAllTransactions(role)
    return {
      items: page.items.map((dto) => toOrderCard(dto)),
      failed: false,
      truncated: page.truncated,
    }
  } catch (error) {
    reportFailure('订单列表', error)
    if (!MOCK_FALLBACK_ENABLED) return { items: [], failed: true, truncated: false }
    const views = await demoOrderViews(role)
    return {
      items: views.map((view) => toOrderCardFromMock(view, demoOpenConversation)),
      failed: false,
      truncated: false,
    }
  }
}

/* --------------------------------------------------------------- 我的 */

/**
 * 个人中心。**真实构建任何失败都返回 `null`，绝不返回 fixture** —— 调用方
 * （`pages/profile`）拿不到真实数据时按空值渲染（数字栏显示 `—`、圆点不显示），
 * 不拿演示账号顶上。
 * 唯一例外是演示构建（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，见下方
 * `loadProfile` 的 catch）：那时登录身份本身就是演示账号，回退的是「当前用户」自己的数据。
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
  /** 待面交笔数 —— 卖家视角（图标栏「卖出」格徽标，#431 任务二） */
  pendingMeetupSell: number
  /** 待面交笔数 —— 买家视角（图标栏「买入」格徽标，#431 任务二） */
  pendingMeetupBuy: number
  /** 全部买卖笔数 */
  orderCount: number
  /**
   * 数字栏（收藏 / 浏览足迹 / 关注）的计数。收藏（#190）与关注（#188）有端点，取真实值；
   * 足迹契约仍没有端点，真实构建给 `null`（页面显示 `—`，不把「系统不知道」画成 0）；
   * 演示构建给演示数字（「我的」页 4 格栏按稿只摆数字不摆图标）。
   */
  favoritesCount: number | null
  historyCount: number | null
  followCount: number | null
}

export async function loadProfile(now: number = Date.now()): Promise<ProfileView | null> {
  try {
    // 收藏计数与收藏列表同源（#190 验收）：`GET /me/favorites` 回包的全量 total，
    // 与 profile 并行拉（count 只读 1 行）。它失败**不算 profile 失败** ——
    // 计数是辅助数字，兜底成 `null` 让页面显示 `—`，不把「读不到」画成 0，
    // 也不让一个辅助请求把整页个人中心拖进错误态。
    const favoritesTotal = fetchMyFavoritesTotal().catch(() => null)
    const profile = await fetchProfile()
    return {
      user: profile.user,
      stats: profile.stats,
      listings: toMockListings(profile.listings, now),
      wishes: profile.wishes.map(toMockWish),
      // 待面交按 role 拆两份（#431 任务二：「卖出」「买入」格各挂各的）。
      // 契约刻意不给买卖条数、由前端按 role 分组（profile/schema.ts 的冻结结论），同口径派生。
      pendingMeetupSell: profile.transactions.filter(
        (tx) => tx.role === 'seller' && tx.status === 'PENDING_MEETUP',
      ).length,
      pendingMeetupBuy: profile.transactions.filter(
        (tx) => tx.role === 'buyer' && tx.status === 'PENDING_MEETUP',
      ).length,
      orderCount: profile.transactions.length,
      // 关注（#188）有端点：`stats.followingCount` 与「我的关注」列表同源（同一张表同一方向）。
      followCount: profile.stats.followingCount,
      // 收藏（#190）：与「我的收藏」列表同源的全量 total；足迹仍没有端点，给 `null` ——
      // 这里的 0 不是「真实结果是 0」而是「系统不知道」，画成 0 等于把未知说成事实
      favoritesCount: await favoritesTotal,
      historyCount: null,
    }
  } catch (error) {
    // `fellBack` 必须**显式**传，不能用默认值：本函数的回退条件比构建默认口径更窄
    // （`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`）。照默认值打日志会在
    // `dev:weapp` 这类「mock 开、演示登录态关」的构建里声称"已回退 mock"，
    // 而实际返回的是 `null` —— 正是 #140 给 `reportFailure` 加这个参数要根除的那种
    // 「日志声称一件没发生的事」。
    reportFailure('个人中心', error, MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED)
    // 演示构建（`TARO_APP_MOCK=1` 且演示登录态开启）才回退演示数据：此时页面的
    // 登录身份本身就是演示账号，摆的是「当前用户」自己的演示数据，不存在
    // 「把演示账号的数据挂在真实用户名下」；真实构建一律 fail-closed 返回 null。
    // 页面侧还有一道保险：`profile.user.id` 不等于当前登录 id 时会被 cancellable 校验丢弃。
    if (!MOCK_FALLBACK_ENABLED || !DEMO_AUTH_ENABLED) return null
    return demoProfile()
  }
}

/**
 * 演示构建的个人中心 fixture：与 `mock/account.ts` 的演示账号同一套数据
 * （我的发布 / 愿望 / 买卖直接取该账号的既有 fixture），
 * 保证「我的」页的角标数字与 mylist / orders 页看到的计数一致。
 * 收藏 / 足迹没有 fixture 来源，按稿给演示数字（8 / 24）；关注沿用设计稿的 5 人，
 * 与 `features/following/demo.ts` 的演示名单条数对齐（数字栏 5、点进去 5 人）。
 * （收藏档的演示口径还要与「我的收藏」页 fixture 对上，见 `pages/favorites/list.ts`。）
 *
 * ⚠️ 只走**失败回退**这条路：`TARO_APP_MOCK=1` 但本机真起了后端时，走的是成功路径，
 * 足迹是 `null` → 页面显示 `—`，收藏 / 关注是服务端真值（演示数字不覆盖真实结果）。
 */
function demoProfile(): ProfileView {
  const {
    wishes,
    saleCount,
    completedCount,
    listings,
    pendingMeetupSell,
    pendingMeetupBuy,
    orderCount,
  } = demoProfileFixtures()
  return {
    user: DEMO_USER,
    stats: {
      activeListings: saleCount,
      activeWishes: wishes.length,
      completedTransactions: completedCount,
      // 与 `features/following/demo.ts` 的演示名单条数一致（方案 §2.3：数字栏与列表不能自相矛盾）
      followingCount: 5,
    },
    listings,
    wishes,
    pendingMeetupSell,
    pendingMeetupBuy,
    orderCount,
    favoritesCount: 8,
    historyCount: 24,
    followCount: 5,
  }
}

/* --------------------------------------------------------------- 愿望 / 匹配 */

/**
 * 许愿页 / 匹配结果页的取数在 `features/wish/load.ts`（真接口，fail-closed）。
 * 这里 re-export 保持页面既有的 `@/features/fetchers` 导入路径不变。
 */
export {
  loadWishes,
  loadWishMatches,
  WISH_HIT_ROWS,
  type WishesResult,
  type WishHitList,
  type WishMatchResult,
} from './wish/load'

/* --------------------------------------------------------- 他人主页（公开资料） */

/**
 * 公开用户主页的加载结果。
 *
 * 四态与商品详情同款（#124 的结论）：`notFound`（后端说这个人不存在 → 空态）与
 * `failed`（根本没问到 → 错误态）必须分开；混成一个 `null` 会让页面把「后端挂了」
 * 说成「用户不存在」。
 *
 * `hasMore` 是读取层对「这份列表是不是全部」的诚实回答（契约 `nextCursor !== null`）：
 * 本页只取一页（上限 50），服务端游标说还有下一页时，页面不能宣称「已经到底了」。
 */
export type PublicUserResult =
  | { status: 'ok'; profile: PublicUserProfile; listings: MockListing[]; hasMore: boolean }
  | { status: 'notFound' }
  | { status: 'failed' }

/**
 * 他人主页：公开资料 + TA 的在售（Issue #122）。
 *
 * **刻意没有 mock 回退**（与 `loadListingDetail` 的 404 分支同一取舍）：mock fixture 是按
 * mock 世界的 id（`u-lin` / `u-suyiran` …）组织的，而本页只接受真实 uuid。给一个真实 uuid
 * 退 mock 等于凭空造出一个用户和一批商品 —— `features/listing/adapt.ts` 的铁律 2 记的正是
 * 这个坑（`getUser` 对未知 id 会回退到 `USERS[0]`）。所以生产与演示构建口径一致：
 * 拿不到真实数据就是 `failed`，由页面显示错误态与重试入口。
 *
 * 两个请求并行：资料与在售互相独立，缺失任一个都无法渲染完整页面。
 */
export async function loadPublicUserHome(
  userId: string,
  now: number = Date.now(),
): Promise<PublicUserResult> {
  try {
    const [profile, page] = await Promise.all([
      fetchPublicUserProfile(userId),
      fetchPublicUserListings(userId),
    ])

    // 后端对「非法 uuid」与「不存在的用户」给同一个 404（契约刻意不区分）。
    if (profile === null && page === null) return { status: 'notFound' }
    // 只有一个 null：两个端点的存在性判断漂移了。按 failed 报，不猜哪一个是真相。
    if (profile === null || page === null) {
      console.warn('[miniapp] 他人主页：资料与在售列表的存在性判断不一致，按失败处理')
      return { status: 'failed' }
    }

    return {
      status: 'ok',
      profile,
      listings: toMockListings(page.items, now),
      // 契约的游标语义：`nextCursor !== null` 即还有下一页。本页不翻页，但这个布尔
      // 是「列表是否完整」的唯一权威信号，必须原样透给页面（不能只看条数猜）。
      hasMore: page.nextCursor !== null,
    }
  } catch (error) {
    reportFailure('他人主页', error, false)
    return { status: 'failed' }
  }
}

/** 供页面把契约 `ListingCard[]` 直接转成卡片视图（详情页相似推荐等） */
export { toMockListings }
