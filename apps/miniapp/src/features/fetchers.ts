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
import type { PublicUserProfile } from '@fish/contracts/users/schema'
import { DEMO_AUTH_ENABLED, DEMO_USER } from '@/features/auth/demo'
import { isApiError, isUnauthenticatedError } from '@/lib/request'
import { MY_LISTINGS, myListingCounts, TRANSACTIONS } from '@/mock/account'
import { type ListingDetailView, myWishes } from '@/mock/api'
import type {
  MockConversation,
  MockListing,
  MockMessage,
  MockNotification,
  MockUser,
  MockWish,
  MockWishPoolItem,
  SearchFilter,
} from '@/mock/types'
import {
  fetchConversation,
  fetchConversationPage,
  fetchMessagePage,
  fetchNotifications,
  markNotificationRead,
} from './chat/api'
import { failureText, isNetworkFailure, mergeMarkReadResults } from './chat/notif-read'
import { toMockListing, toMockListings, toMockSeller } from './listing/adapt'
import {
  fetchCategoryListings,
  fetchHomeFeed,
  fetchListingDetail,
  fetchSimilarListings,
  searchListings,
} from './listing/api'
import { type MatchView, toWishHit, type WishHit } from './match/adapt'
import { fetchWishMatches } from './match/api'
import { fetchProfile } from './profile/api'
import { fetchPublicUserListings, fetchPublicUserProfile } from './user/api'
import { toMockWish, toMockWishPoolItem } from './wish/adapt'
import { fetchMyWishes, fetchWish, fetchWishPool } from './wish/api'

/**
 * 构建期注入（`config/index.ts` 的 `defineConstants.__ALLOW_MOCK_FALLBACK__`）。
 * 本地演示 / 预览用 `TARO_APP_MOCK=1` 打开，或 H5 预览构建直接注入 `true`。
 */
declare const __ALLOW_MOCK_FALLBACK__: boolean | undefined

/**
 * 未注入 = 关闭（fail closed），见文件头「生产口径」。
 *
 * 导出给「不走 fetchers 取数、但需要同一套演示兜底判据」的调用方
 * （当前是底栏的冷启动未读补数：真实构建不得拿 fixture 顶替真实未读数）。
 */
export const MOCK_FALLBACK_ENABLED = __ALLOW_MOCK_FALLBACK__ === true

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
    // 卖家公开资料只为了「卖出 N 件」这一个数：详情契约的 `ListingSellerSchema` 里没有它
    // （只有 id / nickname / avatarUrl / campus / authStatus），所以走 #122 的公开端点。
    // 认证状态**不**从这里取：详情响应本身就带真值，不必多一次请求去问同一件事。
    const [similar, sellerProfile] = await Promise.all([
      fetchSimilarListings(detail.category, detail.id).catch((error) => {
        console.warn('[miniapp] 相似推荐获取失败，本次不展示相似商品', error)
        return []
      }),
      fetchPublicUserProfile(detail.seller.id).catch((error) => {
        console.warn('[miniapp] 卖家公开资料获取失败，本次不展示卖出件数', error)
        return null
      }),
    ])
    const seller: MockUser = toMockSeller(detail, sellerProfile?.soldCount ?? null)
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

/**
 * 把**当前已加载**的未读通知逐条真实标记已读（Owner 拍板口径：切进「通知」tab
 * 即视为已读，tab 红点随之消除）。
 *
 * 只对调用方给出的条目逐条调幂等 `POST /notifications/:id/read` —— 契约没有
 * mark-all-read 端点，客户端不假设有。返回**标记成功**的 id 集合，页面只把
 * 成功条目的本地 `readAt` 补上；失败的条目保持未读，等列表下次变化
 * （错误态的重试钮成功 / 页面实例重建）再试。
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
    const { conversations: mockConversations } = await import('@/mock/api')
    return {
      /**
       * fixture 里的「系统会话」（`kind === 'system'`）是契约外的展示扩展：它不是
       * (商品, 买家×卖家) 的会话，`counterpart` 就是当前用户自己。本轮已按 Owner
       * 决策删掉系统会话行 —— 兜底里不滤掉它，就会在演示构建里以「和自己聊天的
       * 会话行」复活，而且与底栏兜底的口径分叉。
       */
      items: mockConversations()
        .filter((item) => item.kind !== 'system')
        .map(toConversationDto),
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
function toConversationDto(item: MockConversation): ConversationDto {
  return {
    id: item.id,
    listingId: item.listing.id,
    role: item.role,
    listing: item.listing,
    // 多出来的 mock 专属 authStatus 结构上可赋给 ConversationUser，不需要逐字段重建
    counterpart: item.counterpart,
    unreadCount: item.unreadCount,
    // fixture 没有「对方读到哪」这个概念（每个会话只有一条本地读位），给 null：
    // 逐条「已读」的渲染在 Step 3 接 `conversation.read` 时才用得上
    counterpartLastReadAt: null,
    lastMessage: item.lastMessage,
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
    const { conversation: mockConversation } = await import('@/mock/api')
    const found = mockConversation(conversationId)
    return found ? { status: 'ok', conversation: toConversationDto(found) } : { status: 'missing' }
  }
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
    const {
      conversation: mockConversation,
      messages: mockMessages,
      ME: mockMe,
    } = await import('@/mock/api')
    const found = mockConversation(conversationId)
    if (!found) return { items: [], nextCursor: null, failed: false }
    /**
     * fixture 的「我」是 mock 的 `ME`（u-alan），而演示构建里当前登录身份是
     * `DEMO_USER`。契约的 `senderId` 决定气泡画在左边还是右边，所以要把非对方的
     * 发送者对齐到当前身份，否则 fixture 里「我」发的消息会画到对方那一侧。
     */
    const viewer = DEMO_AUTH_ENABLED ? DEMO_USER : mockMe
    return {
      items: mockMessages(conversationId).map((item) => toMessageDto(item, found, viewer)),
      nextCursor: null,
      failed: false,
    }
  }
}

/** 消息发送者需要的最小面（`Me` 与 `MockUser` 都满足） */
type ViewerLike = { id: string; nickname: string; avatarUrl: string | null }

/**
 * 演示构建的 fixture 消息 → 契约 `MessageDto`。
 *
 * 契约对 TEXT 有联合完整性约束（`senderId` 与 `sender` 都必须非空，
 * `messageDtoSchema` 的 refine 同源），而 fixture 只存 `senderId`，
 * 所以要按「这条是不是对方发的」补出 `sender`。`senderId` 也要一起对齐到
 * `viewer`（见调用点的说明）。
 */
function toMessageDto(
  item: MockMessage,
  conversation: MockConversation,
  viewer: ViewerLike,
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
  return {
    id: item.id,
    conversationId: item.conversationId,
    senderId,
    sender,
    type: item.type,
    content: item.content,
    createdAt: item.createdAt,
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
  /** 待面交笔数（设计稿「待面交 N」入口文案） */
  pendingMeetup: number
  /** 全部买卖笔数 */
  orderCount: number
  /**
   * 数字栏（收藏 / 浏览足迹 / 关注）的计数。**契约没有这三个端点**，功能未上线 ——
   * 真实构建给 `null`（页面显示 `—`，不把「系统不知道」画成 0）；演示构建给演示数字
   * （「我的」页 4 格栏按稿只摆数字不摆图标）。
   */
  favoritesCount: number | null
  historyCount: number | null
  followCount: number | null
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
      // 收藏 / 足迹 / 关注没有端点：给 `null`（页面显示 `—`）—— 这里的 0 不是
      // 「真实结果是 0」而是「系统不知道」，画成 0 等于把未知说成事实
      favoritesCount: null,
      historyCount: null,
      followCount: null,
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
 * 收藏 / 足迹 / 关注没有 fixture 来源，按稿给演示数字（8 / 24 / 5）。
 *
 * ⚠️ 只走**失败回退**这条路：`TARO_APP_MOCK=1` 但本机真起了后端时，走的是成功路径，
 * 这三格是 `null` → 页面显示 `—`（演示数字不覆盖真实结果）。
 */
function demoProfile(): ProfileView {
  const wishes = myWishes()
  return {
    user: DEMO_USER,
    stats: {
      activeListings: myListingCounts().sale,
      activeWishes: wishes.length,
      completedTransactions: TRANSACTIONS.filter((tx) => tx.status === 'COMPLETED').length,
    },
    listings: MY_LISTINGS.map((item) => item.listing),
    wishes,
    pendingMeetup: TRANSACTIONS.filter((tx) => tx.status === 'PENDING_MEETUP').length,
    orderCount: TRANSACTIONS.length,
    favoritesCount: 8,
    historyCount: 24,
    followCount: 5,
  }
}

/* --------------------------------------------------------------- 愿望 */

/** 许愿页卡片内嵌展示的命中行数（设计稿是 3 条）；页面的 `slice` 与这里的 `limit` 同源 */
export const WISH_HIT_ROWS = 3

/** 一个愿望的命中：`total` 是服务端阈值过滤后的真实条数，`items` 是前 N 条 */
export type WishHitList = { total: number; items: WishHit[] }

export type WishesResult =
  | { status: 'ok'; mine: MockWish[]; pool: MockWishPoolItem[]; hits: Record<string, WishHitList> }
  | { status: 'failed' }

/**
 * 许愿页一次要的三块数据：我的愿望 + 愿望池 + 每条 ACTIVE 愿望的命中。
 *
 * **刻意没有 mock 回退**（与 `loadPublicUserHome` 同一取舍）：真接口的愿望 id 是 uuid，
 * 而 mock fixture 的 id 是 `w-001` 这种，混在一起只会造出「真实愿望 + 演示命中」的假象。
 * 所以开发 / 预览构建拿不到后端时同样返回 `failed`，由页面显示错误态与重试入口。
 *
 * 命中按愿望逐条拉 `/matches?wishId=`（契约没有批量端点）：只有 `ACTIVE` 且
 * `matchCount > 0` 的愿望才会产生请求，上限是 ACTIVE 愿望条数（服务端限制 10 条）。
 * 单条命中失败不拖垮整页 —— 卡片仍有契约给出的 `matchCount`，只是没有命中行。
 */
export async function loadWishes(): Promise<WishesResult> {
  try {
    const [wishes, pool] = await Promise.all([fetchMyWishes(), fetchWishPool()])
    const mine = wishes
      .map((wish) => toMockWish(wish))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const hits = await loadWishHits(
      mine.filter((wish) => wish.status === 'ACTIVE' && wish.matchCount > 0).map((wish) => wish.id),
    )
    return { status: 'ok', mine, pool: pool.map((item) => toMockWishPoolItem(item)), hits }
  } catch (error) {
    reportFailure('愿望列表', error, false)
    return { status: 'failed' }
  }
}

/**
 * 逐条拉命中。`limit` 就是卡片要展示的行数 —— 卡片上「N 件命中」用响应里的 `total`
 * （阈值过滤后的真实条数）、行用 `items`，两者同源，不会出现「说命中 5 件却一条都点不开」。
 */
async function loadWishHits(ids: string[]): Promise<Record<string, WishHitList>> {
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, WishHitList] | null> => {
      try {
        const result = await fetchWishMatches(id, WISH_HIT_ROWS)
        return [id, { total: result.total, items: result.items.map((item) => toWishHit(item, id)) }]
      } catch (error) {
        console.warn(`[miniapp] 愿望命中获取失败（wishId=${id}）`, error)
        return null
      }
    }),
  )
  return Object.fromEntries(
    entries.filter((entry): entry is [string, WishHitList] => entry !== null),
  )
}

/* --------------------------------------------------------------- 匹配结果 */

/**
 * 契约 `MatchListQuerySchema` / `wishes` 路由都按 uuid 校验目标 id。
 * 用于在客户端先挡掉旧 mock 链接（`w-011`）这类非法 id，避免两个端点给出
 * 404 / 422 两种拒绝、页面状态随竞态抖动。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WishMatchResult =
  | {
      status: 'ok'
      wish: MockWish
      /** `/matches` 的 `total`：阈值过滤后的真实条数，可能大于 `items.length`（limit 截断 / 跳过无法映射的卡片） */
      total: number
      items: MatchView[]
    }
  | { status: 'notFound' }
  | { status: 'failed' }

/**
 * 匹配结果页：愿望本身 + 它的命中商品（含卖家）。
 *
 * `notFound` 与 `failed` 分开的理由与商品详情同款：403 / 404 是后端确切的答复
 * （不是我的愿望 / 已经没了），而网络或契约失败是「没问到」，页面该显示重试而不是
 * 「这条愿望已结束」。
 *
 * `total` 与 `items.length` 都回传：页面计数用 `total`（契约明确两者不该互相推导，
 * 见 `matching/schema.ts` 的 `WishMatchListResponseSchema`）。
 *
 * 卖家：契约的 `WishMatchItem` 只有 `ListingCard`（无 `sellerId`、无 `seller`），
 * 所以逐条拉 `GET /listings/:id` 取详情里的 seller。补不到就是 `null`，页面不渲染
 * 卖家那一格 —— 不编造卖家。请求数与命中条数同阶（上限 50，通常个位数）。
 */
export async function loadWishMatches(wishId: string): Promise<WishMatchResult> {
  // 契约的 wishId 是 uuid。非法 id 先在客户端挡掉：两个请求并行时，`/wishes/:id` 会返
  // 404（router 先做 uuid 校验）而 `/matches` 的 `z.uuid()` 返 422 —— 谁先 reject 谁决定
  // 页面显示「已结束」还是「加载失败」。挡住之后结果确定，也不发注定失败的请求。
  if (!UUID_PATTERN.test(wishId)) return { status: 'notFound' }
  try {
    const [wish, list] = await Promise.all([fetchWish(wishId), fetchWishMatches(wishId)])
    const hits = list.items.map((item) => toWishHit(item, wishId))
    const sellers = await Promise.all(hits.map((hit) => fetchHitSeller(hit.listing.id)))
    return {
      status: 'ok',
      wish: toMockWish(wish),
      total: list.total,
      items: hits.map((hit, index) => ({ ...hit, seller: sellers[index] ?? null })),
    }
  } catch (error) {
    if (isApiError(error) && (error.status === 403 || error.status === 404)) {
      return { status: 'notFound' }
    }
    reportFailure('匹配结果', error, false)
    return { status: 'failed' }
  }
}

/** 命中商品的卖家：拿不到（网络失败 / 商品已删 / 已下架）就返回 `null`，由页面不渲染。 */
async function fetchHitSeller(listingId: string): Promise<MockUser | null> {
  try {
    const detail = await fetchListingDetail(listingId)
    return detail === null ? null : toMockSeller(detail)
  } catch (error) {
    console.warn(`[miniapp] 命中商品卖家获取失败（listingId=${listingId}）`, error)
    return null
  }
}

/* --------------------------------------------------------- 他人主页（公开资料） */

/**
 * 公开用户主页的加载结果。
 *
 * 四态与商品详情同款（#124 的结论）：`notFound`（后端说这个人不存在 → 空态）与
 * `failed`（根本没问到 → 错误态）必须分开；混成一个 `null` 会让页面把「后端挂了」
 * 说成「用户不存在」。
 */
export type PublicUserResult =
  | { status: 'ok'; profile: PublicUserProfile; listings: MockListing[] }
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

    return { status: 'ok', profile, listings: toMockListings(page.items, now) }
  } catch (error) {
    reportFailure('他人主页', error, false)
    return { status: 'failed' }
  }
}

/** 供页面把契约 `ListingCard[]` 直接转成卡片视图（详情页相似推荐等） */
export { toMockListings }

/* --------------------------------------------------------------- 内部 */

/**
 * 失败留痕。登录态缺失与网络不可用属于预期情况（是「当前没有后端 / 没登录」，
 * 不是缺陷），因此降级为 debug；其余（含契约解析失败）用 warn ——
 * 那意味着前端与契约已经漂移，不该被静默吞掉。
 *
 * 日志里必须写明**这次有没有按演示口径兜底**：生产口径下没兜，看日志的人才知道
 * 用户看到的是错误态，而不是以为「又是演示数据」。
 *
 * `fellBack` 是**这次操作实际有没有按演示口径兜底**：调用方知道就传（逐条已读只在
 * 整批后端不可达时才兜底；个人中心只在 `MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`
 * 时才兜），不知道就沿用构建开关的口径。页面若**刻意不回退**（如他人主页，见
 * `loadPublicUserHome`）必须显式传 `false`，否则日志会声称一件没发生的事。
 */
function reportFailure(
  what: string,
  error: unknown,
  fellBack: boolean = MOCK_FALLBACK_ENABLED,
): void {
  const expected = isUnauthenticatedError(error) || isNetworkFailure(error)
  const detail = failureText(error)
  const tail = fellBack
    ? '，已按演示口径处理（开发 / 预览构建）'
    : MOCK_FALLBACK_ENABLED
      ? '，未按演示口径处理'
      : '，未回退 mock（生产口径）'
  if (expected) {
    console.debug(`[miniapp] ${what}：真实接口不可用${tail}（${detail}）`)
    return
  }
  console.warn(`[miniapp] ${what}：真实接口失败${tail}`, error)
}
