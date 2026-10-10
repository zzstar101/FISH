/**
 * 商品详情页（设计稿：`小程序1版listing.html`，冰蓝荧光版）。
 *
 * 区块顺序与设计稿一一对应：
 *   吸顶导航（只有返回钮）→ 图集轮播（378pt，右下圆点）→ 价格区 → 描述段（+ 标签）
 *   → 卖家卡 → 留言区（输入条 + 顶层留言 + 嵌套回复）→ 同类推荐（首页瀑布流卡）→ 底部操作栏
 *
 * 数据走 `@/features/fetchers`（先试真实接口，不可用时内部回退 mock）；尺寸 = 设计稿 pt × 2
 * （见 apps/miniapp/DESIGN.md）。
 *
 * ## 与设计稿的两处**有意偏离**（都不是照抄稿子）
 *
 * 1. **顶部栏吸顶 + 滚动后才长玻璃底**：稿子的 `.mp-nav` 是 `relative`（随内容滚走）。
 *    这里按需求改成 `fixed`：返回钮始终在，栏底色滑过图集后才出现。
 * 2. **右上角不画东西**：稿子在那里画了一个假胶囊，真机上那个位置由微信原生胶囊占用，
 *    画了会被盖住 —— 所以分享 / 更多两个钮直接去掉。
 */

import type { CommentDto } from '@fish/contracts/comments/schema'
import type { ListingMatchListResponse, WishSummary } from '@fish/contracts/matching/schema'
import { Image, Input, Swiper, SwiperItem, Text, View } from '@tarojs/components'
import Taro, {
  useDidShow,
  useLoad,
  usePageScroll,
  useRouter,
  useShareAppMessage,
} from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import ProductCard from '@/components/product-card'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuth } from '@/features/auth/store'
import { createConversation, describeCreateConversationFailure } from '@/features/chat/api'
import { fetchFavoriteState, setFavorite } from '@/features/favorites/api'
import { loadListingDetail } from '@/features/fetchers'
import { offlineListing } from '@/features/listing/api'
import { fetchComments, postComment, postReply } from '@/features/listing/comments'
import { requestSellEdit } from '@/features/listing/edit-target'
import { fetchListingMatches } from '@/features/match/api'
import { usePresenceNow } from '@/features/presence/use-presence-now'
import { presenceView } from '@/features/presence/view'
import { readFeedAttribution } from '@/features/recommendation/attribution'
import { readHiddenListingIds } from '@/features/recommendation/hidden'
import { trackRecommendationEvent } from '@/features/recommendation/track'
import { useListingDetailTracking } from '@/features/recommendation/use-listing-detail-tracking'
import { describeProposeFailure, proposeTransaction } from '@/features/transaction/api'
import {
  initialAmountValue,
  proposalAmountCents,
  proposalAmountError,
} from '@/features/transaction/propose-model'
import { CURRENT_USER_ID } from '@/lib/demo-user-id'
import { categoryLabel, conditionLabel } from '@/lib/listing-labels'
import { formatAmount } from '@/lib/money'
import { backButtonGeometry, readNavMetrics } from '@/lib/nav-metrics'
import { isApiError, isUnauthenticatedError } from '@/lib/request'
import type { ListingDetailView } from '@/mock/api'
import type { MockComment, MockListing } from '@/mock/types'
import {
  type ActionTask,
  beginActionTask,
  beginReloadWrite,
  beginTask,
  type CommentsRead,
  clearedPrivateScope,
  consumeDeferredReload,
  createDeferredReload,
  dropPendingComments,
  hasInflightWrites,
  isColdStartIdentityResolution,
  isCurrentActionTask,
  isLatestLoad,
  isOwnerSwitch,
  isOwnListing,
  isReloadDue,
  isTaskCurrent,
  mergeRefreshedComments,
  type OfflineSubmit,
  ownerChanged,
  ownerStatusNote,
  PENDING_COMMENT_PREFIX,
  requestDeferredReload,
  resolveRefreshedComments,
  settleReloadWrite,
  shouldRefreshOnShow,
  shouldReleaseActionTask,
  shouldReleaseOfflineTask,
  shouldSurfaceStaleAuthFailure,
} from './view'
import './index.scss'

/** 拿不到 id 时的回退商品 */
const FALLBACK_ID = 'l-001'

/** 默认露出的留言条数（设计稿的 LIMIT = 2） */
const COMMENT_LIMIT = 2

/** 瀑布流列宽：750 - 左右各 40 - 列间距 24，再除以 2 */
const COLUMN_WIDTH = 343

/** 图集高度（rpx）：稿子 `.hero` = 378pt = 756rpx，也是玻璃顶栏的触发阈值 */
const GALLERY_RPX = 756

/** 设计稿 `.mini` 的错落比例 → 图片区高度（rpx） */
const RATIO_HEIGHT: Record<MockListing['ratio'], number> = {
  '1x1': COLUMN_WIDTH,
  '4x5': Math.round((COLUMN_WIDTH * 5) / 4),
  '5x6': Math.round((COLUMN_WIDTH * 6) / 5),
  '3x4': Math.round((COLUMN_WIDTH * 4) / 3),
  '4x3': Math.round((COLUMN_WIDTH * 3) / 4),
}

/**
 * 求购行的预算文案（`WishSummary` 的两个预算端点都可空，照抄 DB 真值）。
 * 与许愿页 `budgetRange` 的「¥30–50」同款 en dash；两端都空 = 「预算不限」。
 */
function matchBudgetText(wish: WishSummary): string {
  const { budgetMinCents, budgetMaxCents } = wish
  if (budgetMinCents === null && budgetMaxCents === null) return '预算不限'
  const min = budgetMinCents !== null ? `¥${formatAmount(budgetMinCents)}` : '…'
  const max = budgetMaxCents !== null ? `¥${formatAmount(budgetMaxCents)}` : '…'
  return `预算 ${min}–${max}`
}

/**
 * 页面本地的留言节点。
 *
 * 真实数据下直接消费契约的 `CommentDto.replies`（#111 后不再需要 mock 层级）；
 * `timeLabel` 由契约的 `createdAt` 现算，与 `features/fetchers.ts` 的相对时间同口径。
 */
type CommentNode = {
  id: string
  authorName: string
  authorInitial: string
  isSeller: boolean
  content: string
  timeLabel: string
  replies: CommentNode[]
}

/**
 * 本地乐观插入条目的序号，只用来做列表 key。
 *
 * 为什么不用 `Date.now()`：连发两条会落在同一毫秒，key 撞了会让列表复用到错的节点。
 */
let localSeq = 0

/**
/**
 * 「我」刚发的那一条：先乐观插入本页 state，服务端确认后由 `sendComment` / `sendReply`
 * 换成真实 DTO（拿到真实 id，才能对它回复）；**明确失败时回滚**并给用户可见反馈。
 */
function localComment(content: string): CommentNode {
  localSeq += 1
  return {
    // 前缀是 `view.ts` 的判据常量：切号清场靠它认出「还没被服务端确认」的占位
    id: `${PENDING_COMMENT_PREFIX}${localSeq}`,
    authorName: '我',
    authorInitial: '我',
    isSeller: false,
    content,
    timeLabel: '刚刚',
    replies: [],
  }
}

/** 相对时间文案（与 `features/wish/adapt.ts` 的 relativeLabel 同口径） */
function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const hours = Math.max(0, (now - at) / 3600000)
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))} 分钟前`
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 契约 `CommentDto` → 页面节点（含一层回复）。 */
function dtoToNode(comment: CommentDto): CommentNode {
  return {
    id: comment.id,
    authorName: comment.author.nickname,
    // 头像契约里可为 null；昵称首字兜底，与 mock 的 authorInitial 同语义
    authorInitial: comment.author.nickname.trim().charAt(0) || '鱼',
    isSeller: comment.isSeller,
    content: comment.content,
    timeLabel: relativeTime(comment.createdAt),
    replies: comment.replies.map(dtoToNode),
  }
}

/** 演示构建回退用的 mock 留言 → 页面节点。 */
function mockCommentToNode(comment: MockComment): CommentNode {
  return {
    id: comment.id,
    authorName: comment.authorName,
    authorInitial: comment.authorInitial,
    isSeller: comment.isSeller,
    content: comment.content,
    timeLabel: comment.timeLabel,
    replies: [],
  }
}

/**
 * 加载留言列表。
 *
 * 独立端点（#111）：失败不能拖垮整页 —— 拿不到就退到 fixture（演示构建）或空列表
 * （生产），商品详情本身照常渲染。
 *
 * 返回值必须带上**成败**（#170 复查 N6）：`status: 'failed'` 的兜底列表只给首次加载用，
 * 静默刷新拿到失败结果时不能拿它去合并（那会把已经显示的留言和游标清掉，见 `./view` 的
 * `resolveRefreshedComments`）。
 */
async function loadComments(
  id: string,
  mockFallback: MockComment[],
): Promise<CommentsRead<CommentNode>> {
  try {
    const page = await fetchComments(id)
    return { status: 'ok', comments: page.items.map(dtoToNode), nextCursor: page.nextCursor }
  } catch (error) {
    logCommentFailure('留言列表', error)
    // 演示构建口径下 `loadListingDetail` 已经回退 fixture，这里跟着用同一批 mock 留言；
    // 生产口径拿不到就是空列表（不编数据）。
    return { status: 'failed', comments: mockFallback.map(mockCommentToNode) }
  }
}

/**
 * 留言读写失败的上报口径（只负责留痕，不管界面）。
 *
 * 网络不可用 / 未登录属于**预期**情况（是「当前没连上 / 没登录」，不是缺陷），降为 debug；
 * 其余（后端回了 4xx/5xx、或响应解析失败）说明前端与契约已经漂移，用 warn 留痕。
 *
 * 判据必须看 `errMsg`：`Taro.request` 失败时 reject 的不是 `Error`（是
 * `{ errMsg: 'request:fail …' }`），只判 `instanceof Error` 会把网络失败误当成契约漂移。
 *
 * 为什么不直接复用 `features/fetchers.ts` 的 `reportFailure`：它按 `MOCK_FALLBACK_ENABLED`
 * 拼「已回退 mock / 未回退 mock」，而留言读写与那个开关无关，套过来会说一句假话。
 */
function logCommentFailure(what: string, error: unknown): void {
  const errMsg =
    error instanceof Error
      ? error.message
      : String((error as { errMsg?: unknown } | null)?.errMsg ?? '')
  const expected = isUnauthenticatedError(error) || /request:fail|network|timeout/i.test(errMsg)
  if (expected) {
    console.debug(`[miniapp] ${what}：接口不可用`, error)
    return
  }
  console.warn(`[miniapp] ${what}：接口失败`, error)
}

/**
 * 把写失败翻译成可操作的提示文案。
 *
 * 回滚了本地占位还不够：用户点了发送却什么都没看到，会以为没点上。
 * 422 直接展示服务端文案（「留言内容未通过审核」这类）；404 / 401 给更具体的引导。
 */
function commentFailureMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 422) return error.message || '内容未通过审核'
    if (error.status === 404) return '商品或留言已不存在'
    if (error.status === 401) return '请先登录后再操作'
  }
  return '发送失败，请重试'
}

/** 写失败的**可见**反馈：留痕 + 弹提示（调用方负责先回滚本地占位）。 */
function notifyCommentFailure(what: string, error: unknown): void {
  logCommentFailure(what, error)
  void Taro.showToast({ title: commentFailureMessage(error), icon: 'none' })
}

/** 「2 小时前发布」——mock 只给相对小时数 */
function postedLabel(hoursAgo: number): string {
  if (hoursAgo < 1) return '刚刚发布'
  if (hoursAgo < 24) return `${Math.round(hoursAgo)} 小时前发布`
  const days = Math.round(hoursAgo / 24)
  return days <= 1 ? '昨天发布' : `${days} 天前发布`
}

/** 设计稿的描述是两段；mock 只有一段时按第一个句末标点断成两行 */
function descriptionLines(description: string): string[] {
  const trimmed = description.trim()
  if (!trimmed) return []
  const explicit = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (explicit.length > 1) return explicit
  const cut = trimmed.search(/。(?![\d])/)
  if (cut < 0 || cut >= trimmed.length - 1) return [trimmed]
  return [trimmed.slice(0, cut + 1), trimmed.slice(cut + 1)]
}

function splitColumns(items: MockListing[]): [MockListing[], MockListing[]] {
  const left: MockListing[] = []
  const right: MockListing[] = []
  items.forEach((item, index) => {
    if (index % 2 === 0) left.push(item)
    else right.push(item)
  })
  return [left, right]
}

/**
 * 详情页的加载状态机。
 *
 * 不能用 `data === null` 同时表达「尚未加载」和「notFound」：那样骨架屏分支
 * 永远先命中，「商品不存在或已下架」的空态不可达 —— 已删除 / 不存在的商品
 * （从相似推荐、通知、旧分享链接进来）全部表现为无限加载（#121）。
 * `notFound`（商品真不存在 → 空态）与 `failed`（根本没问到 → 错误态）必须分开。
 */
type LoadState = 'loading' | 'ok' | 'notFound' | 'failed'

export default function ListingDetail() {
  const router = useRouter()
  const id = router.params.id ?? FALLBACK_ID

  /**
   * 推荐归因：从推荐流点进来时 URL 上带 `rid` / `pos` 两个参数（见 `@/features/recommendation/attribution`）。
   * 搜索 / 分类 / 卖家主页进来的没有归因 —— 本页照样发 DETAIL_VIEW，只是不带 requestId。
   */
  const attribution = readFeedAttribution(router.params)

  const [data, setData] = useState<ListingDetailView | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')

  /**
   * 右上角菜单转发：把这件商品分享给同学 / 群，卡片直达本页。冷启动直入时页面栈
   * 只有本页，返回键已由 `handleBack` 的栈空兜底接住（回首页）。演示构建里 `data`
   * 是 fixture（id 不在库里），分享出去别人打不开 —— 与本页其它演示行为一致。
   */
  useShareAppMessage(() => {
    const listing = data?.listing ?? null
    const title = listing
      ? listing.free
        ? `${listing.title} · 0 元送`
        : `${listing.title} · ¥${formatAmount(listing.priceCents)}`
      : '鱼小应 · 校园闲置'
    return {
      title,
      path: `/pkg-browse/pages/listing-detail/index?id=${id}`,
      ...(listing?.images[0] ? { imageUrl: listing.images[0] } : {}),
    }
  })

  const [slide, setSlide] = useState(0)
  /**
   * 心形的收藏态。契约的 `ListingCardSchema` 与详情投影**都不带**收藏标记，所以只能问
   * `GET /listings/:id/favorite`（见下面的 effect）。
   *
   * 瀑布流卡片不能这么做（一屏二三十张就是二三十个请求），那边是**长按时才问一次**，
   * 见 `components/product-card`；本页一次只展示一件商品，多这一个请求是划算的。
   */
  const [faved, setFaved] = useState(false)
  /** 心形的写在途：挡住连点，避免同一件商品被写两遍 */
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  /**
   * 「同类推荐」里本机已隐藏的 id：进页读一次本地名单，之后由卡片菜单的 `onDislike` 累加。
   * 卡片自己也会隐藏（它读同一份名单），但**页面这份列表**也得跟着少一条 ——
   * 否则全部隐藏完时，「同类推荐」会剩一个只有标题的空区块。
   */
  const [hiddenSimilar, setHiddenSimilar] = useState<readonly string[]>(() =>
    readHiddenListingIds(),
  )
  /** 「立即购买」是否已确认过：确认一次就进入「待店家确认」终态（账号私有，换号清场） */
  const [buyRequested, setBuyRequested] = useState(false)
  /** 「立即购买」确认弹层（对齐 PC buy-dialog：商品摘要 + 可改金额 + 注释；账号私有，换号清场） */
  const [buyOpen, setBuyOpen] = useState(false)
  /** 弹层金额输入框：默认带挂价、可改；免费送锁 `'0'`（初值在 `openBuy` 里按商品写入） */
  const [buyAmount, setBuyAmount] = useState('')
  /** 弹层金额字段的本地校验错误文案 */
  const [buyAmountError, setBuyAmountError] = useState<string | null>(null)
  /** 弹层提交失败的展示文案（弹层内展示，不用 toast —— 失败语境要贴着输入框） */
  const [buySubmitError, setBuySubmitError] = useState<string | null>(null)
  /** 弹层提交在飞：确认钮转「正在发起…」，两步写没落地前弹层不许关 */
  const [buyBusy, setBuyBusy] = useState(false)
  /** 下架二次确认卡是否开着（卖家视角「管理 → 下架」；账号私有，换号清场） */
  const [offlineConfirmOpen, setOfflineConfirmOpen] = useState(false)
  /** 下架确认卡按钮三态：确认下架 / 下架中 / 重试（同我的发布页的 submit 状态机） */
  const [offlineSubmit, setOfflineSubmit] = useState<OfflineSubmit>('idle')
  const [commentsOpen, setCommentsOpen] = useState(false)
  /** 留言树（顶层各带 replies）：初值来自加载结果，之后由本页的本地写操作增长 */
  const [comments, setComments] = useState<CommentNode[]>([])
  /** 留言列表的下一页游标；`null` = 没有更多（或还没加载完 / 退了 mock）。 */
  const [commentsCursor, setCommentsCursor] = useState<string | null>(null)
  /** 「加载更多」的重入守卫（ref：state 更新是异步的，连点两次会都读到 false）。 */
  const loadingMoreRef = useRef(false)
  /** 「加载更多」在飞：把文字链换成「正在加载…」（`following` / `chat` 的页脚同款口径）。 */
  const [loadingMore, setLoadingMore] = useState(false)
  /** 组件是否还挂着；卸载后不再 setState（翻页是多次 await，中途离开页面很常见）。 */
  const mountedRef = useRef(true)
  const [commentInput, setCommentInput] = useState('')
  /** 正在回复哪条顶层留言（`null` = 没有展开回复行）；稿子同时只开一行 */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyInput, setReplyInput] = useState('')

  /**
   * 当前账号。
   *
   * 本页是**公开页**：不挂 `useAuthGuard`，匿名也能读；账号只用来决定「哪些是账号
   * 私有的东西、换号时该清掉」（#170 判据 C）。
   */
  const { user, status: authStatus } = useAuth()
  const userId = user?.id ?? null
  /** 上一个渲染看到的账号：换号要在**渲染期**同步清场，用 effect 会晚一帧画出上个账号的草稿 */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  /** 账号世代：换号与卸载都 +1，让在途写入的迟到响应作废 */
  const epochRef = useRef(0)
  /** 异步回调（`.then` / `.catch` / `useDidShow`）里读账号要拿**当前**值，不能读闭包里的旧值 */
  const ownerRef = useRef<string | null>(null)
  ownerRef.current = userId
  /** 详情 / 留言读取的请求序号：重试与返回刷新只有最新那一次能写入（判据 D） */
  const loadSeqRef = useRef(0)
  /**
   * 上一次上报过的轮播下标。
   *
   * R1 §3.5 规定首屏自动展示第一张**不算**用户主动查看，所以 `IMAGE_VIEW` 只在「下标真的变过」
   * 时才发：初始化那次 `onChange`（如果宿主给了）的下标与它相等，于是被挡掉。
   */
  const slideRef = useRef(0)
  /** 当前留言树：`refresh` 起飞时要按它记下 id 快照，而它可能从更早一帧的闭包里被调到 */
  const commentsRef = useRef<CommentNode[]>([])
  commentsRef.current = comments
  /**
   * 返回刷新与在途写入的账（判据 D），并且**归当前账号所有**（判据 C）。
   *
   * 旧实现是一个裸计数 + 一个裸布尔：A 的在途写入迟到结算时会替 B 销账，还能用 A
   * 留下的标记在 B 的页面上补跑一次刷新。带上 epoch 之后，带旧 epoch 的结算一律不认。
   */
  const reloadRef = useRef(createDeferredReload())
  /** 首次 show 让给 `useLoad` 的首屏加载，免得一进页双发 */
  const firstShowRef = useRef(true)
  /**
   * 底栏两个动作的在飞锁：各自持有**某一次点击**的令牌（`null` = 它没有在途动作）。
   *
   * 两把独立的锁：两个钮互不相干，一个在飞不该把另一个也按死。
   */
  const chatInFlightRef = useRef<number | null>(null)
  const buyInFlightRef = useRef<number | null>(null)
  /** 令牌发号器：只增不减，保证 A 的迟到收尾认不出 B 的锁 */
  const actionSeqRef = useRef(0)
  /**
   * 「管理」ActionSheet 的在飞锁：拿的同样是**某一次点击**的令牌（`null` = 没有在途弹层）。
   *
   * 弹出层（原生 ActionSheet）的 `.then` 是跨帧回调：等待期间换号 / 卸载之后，A 的
   * `tapIndex` 仍会去写编辑交接、`switchTab` 或重开卖家下架卡。铸任务见 `manageListing`，
   * 校验见 `isCurrentActionTask`。
   */
  const menuInFlightRef = useRef<number | null>(null)
  /** 下架请求在飞守持的令牌（`null` = 没有在途请求；同 `chatInFlightRef` 的口径） */
  const offlineInFlightRef = useRef<number | null>(null)

  /**
   * 换号 / 退出：渲染期同步清掉账号私有的 state。
   *
   * 公开快照（`data` / `loadState` / 已确认的 `comments`）**不清** —— 商品与已发布的
   * 留言对任何账号都是同一份，清了只会白闪一次骨架屏。
   */
  if (ownerChanged(prevUserId, userId)) {
    setPrevUserId(userId)
    epochRef.current += 1
    // 在途写入的账整本换新：上一代的结算带的是旧 epoch，从此一律不认 —— 既不能替
    // 新账号销账，也不能用上一代留下的 deferred 标记在新账号的页面上补跑一次刷新
    reloadRef.current = createDeferredReload(epochRef.current)
    // 读取链同样是账号作用域：真正的换号要把在途的 load / refresh / 翻页一并作废，
    // 迟到的公开快照不许写进新账号的页面。冷启动解析身份（null → id）不算换号，
    // 那会把首屏 `load` 判过期、页面永远停在骨架屏上
    if (isOwnerSwitch(prevUserId)) {
      loadSeqRef.current += 1
      // 两个动作的在飞锁同样只在**真换号**时作废：A 发起的建会话请求 / 还开着的购买
      // 弹窗不属于 B，锁要还给 B —— 不清的话 B 点下去会被 A 的在途动作一直堵着。
      // 冷启动解析身份是同一个人（cookie 本来就取自本地存储），锁必须留着：
      // 清掉它 `isColdStartIdentityResolution` 的「仍持有那把锁」就永远不成立，
      // 那次点击又会被判过期（等于白改）。
      chatInFlightRef.current = null
      buyInFlightRef.current = null
      // 「管理」ActionSheet 与「下架」请求同理：A 的弹层回调 / 在途下架不属于 B。锁在这里
      // 作废（置 `null`）之后，A 的迟到回调连令牌都对不上，`isCurrentActionTask` 必定拒绝 ——
      // 只靠 `ownerId` + `epoch` 不够：A → B → A 时账号名又相等，得靠这把锁的归属区分。
      menuInFlightRef.current = null
      offlineInFlightRef.current = null
    }
    const cleared = clearedPrivateScope()
    setCommentInput(cleared.commentInput)
    setReplyInput(cleared.replyInput)
    setReplyTo(cleared.replyTo)
    setFaved(cleared.faved)
    // 购买请求是当前账号发出的：换号后「待店家确认」不属于下一个账号
    setBuyRequested(cleared.buyRequested)
    /*
      购买确认弹层（草稿金额 / 两处错误 / 在飞态）**只在真换号时**复位。
      冷启动解析身份（`null → id`）走 `ownerChanged` 但不走 `isOwnerSwitch`：那时弹层
      可能已经打开、两步写正在飞（入口刻意放行 `unknown`，`isColdStartIdentityResolution`
      也会让这次飞行继续作数）。放在这里之外复位，会让身份一解析就关层 + `buyBusy` 清零，
      而那次写还在飞 —— 它若失败，文案会被写进一个已经关掉的弹层，用户什么都看不到。
    */
    if (isOwnerSwitch(prevUserId)) {
      setBuyOpen(cleared.buyOpen)
      setBuyAmount(cleared.buyAmount)
      setBuyAmountError(cleared.buyAmountError)
      setBuySubmitError(cleared.buySubmitError)
      setBuyBusy(cleared.buyBusy)
    }
    // 下架确认卡是卖家视角的操作面板：下一个账号未必还是这件商品的卖家，
    // 连卡带请求三态一起复位，别把 A 的「下架中」留给 B
    setOfflineConfirmOpen(cleared.offlineConfirmOpen)
    setOfflineSubmit(cleared.offlineSubmit)
    // 未确认的占位属于上一个账号：清场后它的 .then / .catch 已被 epoch 作废，
    // 留着就是一条永远等不到确认、却对下一个账号可见的幽灵留言。
    setComments((prev) => dropPendingComments(prev))
  }

  useEffect(
    () => () => {
      mountedRef.current = false
      // 卸载也作废在途任务：迟到的读取与写入都不该再碰一个已经不在的页面
      epochRef.current += 1
      loadSeqRef.current += 1
    },
    [],
  )

  /**
   * DETAIL_VIEW 与 LONG_VIEW（R1 §3.5）。
   *
   * 传的是**已经加载出来**的商品 id：商品不存在（`notFound`）或还没加载完时传 `null`，
   * 那时不发事件 —— 发一条指向不存在的商品只会被服务端按 `listing_not_found` 拒收。
   */
  useListingDetailTracking(data?.listing.id ?? null, attribution)

  const metrics = useMemo(() => readNavMetrics(), [])
  const backGeo = backButtonGeometry(metrics.capsuleHeight)

  /**
   * 玻璃顶栏的触发阈值（设备 px）。
   *
   * `scrollTop` 的单位是 px，而图集高度写在样式表里是 756rpx —— 两者不是同一个量，
   * 必须按 `1rpx = 屏宽 / 750` 换算，不能直接拿 756 比。
   */
  const galleryPx = useMemo(() => {
    try {
      return (GALLERY_RPX * Taro.getWindowInfo().windowWidth) / 750
    } catch {
      // 取不到窗口宽度（h5 预览等）时按 375pt 屏折算，至少阈值不是 0
      return GALLERY_RPX / 2
    }
  }, [])

  const [navSolid, setNavSolid] = useState(false)
  /** 回到顶部钮（共享组件）：滚过一屏浮现 */
  const [showTop, setShowTop] = useState(false)
  /** 上一次的滚动状态：滚动事件每帧都来，只有跨过阈值那一次才需要 setState */
  const navSolidRef = useRef(false)

  /**
   * 顶部有没有 756rpx 的图集（骨架屏那块就是图集占位）。
   *
   * 错误态（LoadError）与空态都没有图集可滑，页面却仍能滚出 `.detail` 的底部留白，
   * 此时任何滚动都算「内容开始从栏下经过」—— 否则栏会一直透明、内容直接从它下面滑过去。
   * scrollTop = 0 两种情况下都不显示。
   */
  const hasGalleryBlock = loadState === 'loading' || Boolean(data?.listing)
  /** 玻璃底出现的滚动阈值（设备 px）：见上 */
  const navSolidThreshold = hasGalleryBlock ? galleryPx : 1

  usePageScroll(({ scrollTop }) => {
    // 回到顶部钮：滚过一屏浮现（要在 solid 的早退之前算，否则滚动值不变时它不更新）
    setShowTop(scrollTop > BACK_TOP_THRESHOLD)
    const solid = scrollTop >= navSolidThreshold
    if (solid === navSolidRef.current) return
    navSolidRef.current = solid
    setNavSolid(solid)
  })

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /**
   * 读一次心形的真实收藏态。
   *
   * 依赖 `authStatus` 与 `userId`：匿名进来时先不问（该端点挂 `requireAuth`，问了必然 401），
   * 等登录态解析成 `authed` 再问；**换账号**（`userId` 变）也要重问 ——
   * `clearedPrivateScope` 在渲染期把 `faved` 清成 `false`，那是「不属于新账号」的复位，
   * 不等于「新账号没收藏过这件」。
   *
   * 读失败（网络 / 未登录）**不报错、也不拦页面**：心形不是这一页的主内容，保持未选中即可，
   * 真点下去时由写接口给出准确结论。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) {
      setFaved(false)
      return
    }
    let live = true
    void fetchFavoriteState(id)
      .then((state) => {
        if (live) setFaved(state.favorited)
      })
      .catch(() => {
        // 见上：读不到就保持未选中
      })
    return () => {
      live = false
    }
  }, [id, authStatus, userId])

  /**
   * 心形：真写 `POST|DELETE /listings/:id/favorite`（幂等，见 `@/features/favorites/api`）。
   *
   * 匿名点击**不发请求**（必然 401），直接提示去登录 —— 与「聊一聊」同一口径。
   * **以服务端返回为准**：本地不先翻转（`faved` 只在响应落地时改），
   * 所以写失败时心形不会假装变过。
   */
  const toggleFavorite = () => {
    if (favoriteBusy) return
    if (authStatus !== 'authed') {
      void Taro.showToast({ title: '请先登录后再收藏', icon: 'none' })
      return
    }
    setFavoriteBusy(true)
    void setFavorite(id, !faved)
      .then((state) => {
        setFaved(state.favorited)
      })
      .catch((error: unknown) => {
        // 写路径上的 404 只有一个含义：这件东西已经不在货架上了（见 `favorites/api`）
        if (isApiError(error) && error.code === 'LISTING_NOT_FOUND') {
          void Taro.showToast({ title: '这件宝贝已经下架或卖掉了', icon: 'none' })
          return
        }
        void Taro.showToast({
          title: isUnauthenticatedError(error) ? '请先登录后再收藏' : '收藏没成功，请重试',
          icon: 'none',
        })
      })
      .finally(() => {
        setFavoriteBusy(false)
      })
  }

  const load = () => {
    loadSeqRef.current += 1
    const seq = loadSeqRef.current
    // 重试先清残留：上一轮的 notFound / failed 终态与旧数据不能带进新一轮加载（#121）
    setData(null)
    setLoadState('loading')
    // 三态分明：`ok` 渲染详情、`notFound` 走空态（商品真不存在）、
    // `failed` 走错误态 —— 生产口径不退回 mock，拿演示商品顶上比空态更误导
    void loadListingDetail(id).then(async (result) => {
      // 迟到的一轮不能盖掉最新一轮（判据 D：重试不接受陈旧响应）
      if (!isLatestLoad(seq, loadSeqRef.current)) return
      const view = result.status === 'ok' ? result.view : null
      setData(view)
      setLoadState(result.status === 'ok' ? 'ok' : result.status)
      // 详情一到就收骨架屏：留言是独立端点（#111），不能让它把商品本身的展示拖住。
      // 留言异步加载（不等详情的终态）：失败不拖垮整页，也不丢掉已拿到的商品信息。
      if (view) {
        const loaded = await loadComments(id, view.comments)
        if (!isLatestLoad(seq, loadSeqRef.current)) return
        // 首次加载 / 重试：留言读失败仍展示兜底列表（既有口径），但分页游标只在**成功**
        // 读取时才收下 —— 失败时那个 `null` 不是「没有下一页」，是「不知道」。
        setComments(loaded.comments)
        setCommentsCursor(loaded.status === 'ok' ? loaded.nextCursor : null)
      } else {
        setComments([])
        setCommentsCursor(null)
      }
    })
  }

  /**
   * 从子页返回时的**静默**同步（#170 判据 D）。
   *
   * 与 `load` 的区别是**不**清残留、**不**回骨架屏：返回时把已经读起来的商品与留言
   * 整页拆掉重建，等于每次返回都打断一次阅读。刷新失败也保留现有内容 —— 一次网络
   * 抖动不该把画好的页面翻成错误态；只有服务端明确说这件商品没了（下架 / 删除）
   * 才切空态，否则页面会永远停在过期快照上。
   *
   * 留言这条链同理（#170 复查 N6）：留言请求失败时既不动已有留言也不动分页游标，
   * 而不是把失败兜底的空列表当成「服务端说没有留言」合并进去。
   */
  const refresh = () => {
    loadSeqRef.current += 1
    const seq = loadSeqRef.current
    // 刷新**起飞这一刻**的 id 快照（含嵌套回复）：落地时用它认出「刷新期间才落地的写入」。
    // 没有它就只能整体覆盖留言树，把用户刚发的那条抹掉 —— 而它的 `.then` 随后已经找不到
    // 自己的节点，服务端写成功了、界面上却凭空消失（判据 D，见 `./view` 的合并规则）
    const baseIds = new Set(
      commentsRef.current.flatMap((node) => [node.id, ...node.replies.map((reply) => reply.id)]),
    )
    void loadListingDetail(id).then(async (result) => {
      if (!isLatestLoad(seq, loadSeqRef.current)) return
      if (result.status !== 'ok') {
        if (result.status === 'notFound') {
          setData(null)
          setLoadState('notFound')
          setComments([])
          setCommentsCursor(null)
        }
        return
      }
      setData(result.view)
      setLoadState('ok')
      const loaded = await loadComments(id, result.view.comments)
      if (!isLatestLoad(seq, loadSeqRef.current)) return
      // 留言读失败时**不落地**（#170 复查 N6）：保留已经显示出来的留言与游标，等下一次
      // 刷新重试。一次网络抖动不该把留言清空 —— 那和「服务端真的没有留言」是两回事。
      // 成功读到空列表照常合并：那是服务端确认过的空，不能永久停在旧快照上。
      const applied = resolveRefreshedComments(loaded)
      if (!applied) return
      setComments((prev) => mergeRefreshedComments(prev, applied.comments, baseIds))
      setCommentsCursor(applied.nextCursor)
    })
  }

  /**
   * 进入「要刷新」这一步：本代还有写入在飞就先记账延后（`#170` 判据 D 的「写入在飞
   * 可延后，但不能丢掉这次刷新」）。
   *
   * 乐观占位本身由 `refresh` 的合并规则兜住（刷新期间落地的写入不会被覆盖），延后是
   * 为了别让一次返回刷新与用户刚点的发送抢同一份列表状态；记账而不是取消，所以写入
   * 结算后由 `sendComment` / `sendReply` 的 `finally` 补跑一次，这次刷新不会被丢掉。
   */
  const requestRefresh = () => {
    if (hasInflightWrites(reloadRef.current)) {
      reloadRef.current = requestDeferredReload(reloadRef.current)
      return
    }
    refresh()
  }

  /**
   * 一笔写入结算：先按**发起这次写入时**的 epoch 销账（旧世代的结算原样返回 —— 既不替
   * 新账号销账，也不代表新账号没有在途写入），再看被延后的那次返回刷新该不该补跑
   * （`finally` 无论成败都会到这里）。
   */
  const finishWrite = (epoch: number) => {
    reloadRef.current = settleReloadWrite(reloadRef.current, epoch)
    if (!isReloadDue(reloadRef.current)) return
    reloadRef.current = consumeDeferredReload(reloadRef.current)
    refresh()
  }

  useLoad(() => {
    load()
  })

  useDidShow(() => {
    // 首次 show 与 `useLoad` 的首屏加载是同一次进入，跳过免得双发
    const firstShow = firstShowRef.current
    firstShowRef.current = false
    // 本机隐藏名单是跨页的：别的页面刚隐藏的商品要在这里跟着消失（见 `hiddenSimilar`）
    setHiddenSimilar(readHiddenListingIds())
    if (!shouldRefreshOnShow(firstShow)) return
    requestRefresh()
  })

  /*
    「同类推荐」是复用首页那张瀑布流卡的第三处（首页 / 搜索 / 这里）。

    **分列按服务端那份原列表**（`data.similar`），隐藏只让对应的那张卡自己不渲染：
    先过滤再分列的话，隐藏一件会让它后面每张卡换列（`splitColumns` 按 index 奇偶），
    跨父节点移动 = React 卸载重挂（图片重载），用户看到整片跳一下。
    `visibleSimilarCount` 只为「还有没有内容可推荐」这一件事服务（空区块不该只剩标题）。
  */
  const similarAll = useMemo(() => data?.similar ?? [], [data])
  const [leftSimilar, rightSimilar] = useMemo(() => splitColumns(similarAll), [similarAll])
  const visibleSimilarCount = useMemo(
    () => similarAll.filter((item) => !hiddenSimilar.includes(item.id)).length,
    [similarAll, hiddenSimilar],
  )

  /**
   * 卖家视角（Owner 2026-09-27 拍板）：当前账号是这件商品的卖家时，底部栏换成
   * 「管理 / 看谁想要」。每帧用**当前** userId 重算（见 `view.isOwnListing`），
   * 换号不用清场就会自动切回买家形态。非在售（本人可见的 OFFLINE / SOLD /
   * RESERVED）不渲染操作钮，整条换成状态行。
   *
   * 归属比对用的「当前用户」在演示档下要换成 mock 世界的「我」（`@/lib/demo-user-id`
   * 的 `CURRENT_USER_ID = 'u-alan'`，与 `mock/users` 的 `ME.id` 同源）：演示登录态是
   * `DEMO_USER` 的 uuid，而 fixture 商品的 sellerId 全是 `u-*` —— 拿 uuid 比对永远
   * 不相等，卖家视角在演示构建里永远出不来。常量取自 `@/lib/demo-user-id` 而非
   * `@/mock/users` 是为了不把整份用户 fixture 拖进生产包（`@/mock/users` 顶层构造
   * `USERS`/`USER_BY_ID`），两者取值由 re-export 保证不会漂移。
   * 真实构建 `DEMO_AUTH_ENABLED` 是编译常量 `false`，走真实会话 id。
   *
   * 边界：`TARO_APP_MOCK=1` 但本机 API 可达时详情走真接口（sellerId 是真实 uuid），
   * 钉死的 `'u-alan'` 同样永不匹配 —— 那种组合下卖家视角不可达；演示口径是
   * 「后端不可达、fixture 回退」，两个演示开关不要混用。
   *
   * 退出登录后 `userId` 为 `null` 时**不许**回落到钉死的演示账号：本页不挂登录守卫，
   * 那会让匿名态渲染出卖家底栏，「匿名永远是买家形态」的判据当场破掉。
   */
  const ownerViewUserId = DEMO_AUTH_ENABLED && userId !== null ? CURRENT_USER_ID : userId
  const ownListing = data !== null && isOwnListing(data.listing.sellerId, ownerViewUserId)
  /*
   * 状态行要读审核态与治理标记：它们只在**卖家本人视角**非 null（契约如是说），
   * 本行又只在 `ownListing` 为真时才算 —— 两件事恰好对上，不必再判一次视角。
   * mock fixture 不带这两个字段，缺省即「已通过、非治理下架」，与公开读模型同义。
   */
  const ownerNote =
    ownListing && data !== null
      ? ownerStatusNote(
          data.listing.status,
          data.listing.moderationStatus ?? null,
          data.listing.governanceDelisted === true,
        )
      : null

  /**
   * 卖家在线态（#359 第五点）：卖家行里、头像右侧那一列的昵称行。
   *
   * 数据来自详情页**并行拉取**的公开资料（见 `features/fetchers.ts` 的 `loadListingDetail`，
   * 「卖出 N 件」与在线态同一次请求），没有额外接口；拿不到（fixture 兜底 / 那次请求失败）
   * 时 `data.seller.presence` 为 null → 整块不渲染，不画一个假的「离线」。
   * 判据与文案走三处展示位共用的 `features/presence/view`。
   *
   * 「现在」走 `usePresenceNow`（#376 审查回合）：本页只在进页拉一次详情，没有任何
   * 轮询能带来重渲染，直接用 `Date.now()` 等于把 TTL 过期判据冻在首帧。该 hook 不发
   * 请求，页面被盖住（例如跳去看会话）时停表。
   */
  const sellerPresenceNow = usePresenceNow()
  const sellerPresence = data ? presenceView(data.seller.presence, sellerPresenceNow) : null

  /**
   * 「谁在求购」（#8 的 byListing 端点）：**卖家本人视角**的匹配愿望列表。
   *
   * 端点整挂 requireAuth 且服务端校验归属（非本人 403 `NOT_TARGET_OWNER`），所以只在
   * `ownListing` 时发请求；它是本页的辅助区块 —— 拉不到（未登录 / 网络失败 / 商品被删）
   * 就整块不渲染，不弹错误也不连累页面主体。`matches === null` 即「没有可展示的」。
   */
  const [matches, setMatches] = useState<ListingMatchListResponse | null>(null)
  const matchListingId = data?.listing.id ?? null
  useEffect(() => {
    if (!ownListing || matchListingId === null) return
    let stale = false
    setMatches(null)
    fetchListingMatches(matchListingId)
      .then((result) => {
        if (!stale) setMatches(result)
      })
      .catch((caught: unknown) => {
        console.debug('[miniapp] 谁在求购读不到，隐藏区块', caught)
      })
    return () => {
      stale = true
    }
    // 依赖商品 id 而不是 `data` 对象引用：返回本页的静默刷新会换 `data` 引用但商品没变，
    // 以引用为依赖会每次返回都白打一发匹配请求
  }, [ownListing, matchListingId])

  /**
   * 返回：有上一页就回退，否则回首页 —— 与 `components/nav-bar` 同一行为。
   *
   * 本页不再用那个组件（它的钮是 `absolute`，会随内容滚走，且尺寸/留白与稿子不符），
   * 但返回语义必须一致，所以在这里就地复刻，而不是去改被 12 个页面共用的组件。
   */
  const handleBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      void Taro.navigateBack()
    } else {
      void Taro.switchTab({ url: '/pages/home/index' })
    }
  }

  /**
   * 底栏动作的在飞任务是否还作数（两个动作共用）。
   *
   * 除了「账号 + 代次 + 令牌全等」，还要放过**冷启动解析身份**那一次代次前进：
   * 本页公开、底栏一进来就点得动，而登录态解析（`unknown → authed`）会在点击之后
   * 才落地。请求带的 cookie 本来就取自本地存储、是同一个账号，把这一次判过期等于
   * 「点了没反应」（会话其实已经建好了）。判据见 `isColdStartIdentityResolution`
   * —— 它同时要求「发起时确实是 `unknown`」与「仍持有那把锁」，不是无条件放行。
   */
  const isTaskLive = (task: ActionTask, inFlight: number | null): boolean =>
    isCurrentActionTask(task, {
      ownerId: ownerRef.current,
      epoch: epochRef.current,
      token: inFlight,
    }) ||
    isColdStartIdentityResolution(task, {
      ownerId: ownerRef.current,
      epoch: epochRef.current,
      token: inFlight,
    })

  /**
   * 「聊一聊」：与这件商品的卖家建/取会话后跳会话页 —— 与匹配结果页（#67 第二步）
   * 同一条路径：`POST /conversations` 以商品 id 为入参，服务端对同一 (listingId, 买家)
   * **复用**既有会话，所以本页不做本地缓存，重复点击就是幂等的重发。
   *
   * 本页是公开页、匿名可读，而会话端点挂 `requireAuth`：匿名点击让请求走一圈、
   * 401 后按本页留言区的口径提示去登录。
   *
   * 令牌在**发起前**捕获（同 `pages/match` 的 `ChatTask`）：建会话是账号作用域的写操作，
   * A 发起后退出 / 换 B / 离开本页，迟到的响应不许再压出会话页、弹 toast 或占着 B 的锁。
   */
  const chatWithSeller = () => {
    if (chatInFlightRef.current !== null) return
    actionSeqRef.current += 1
    const task = beginActionTask(
      epochRef.current,
      ownerRef.current,
      actionSeqRef.current,
      authStatus,
    )
    chatInFlightRef.current = task.token
    /** 只释放自己的锁：换号后 B 重新发起时，A 的迟到收尾不能删掉 B 的标记 */
    const release = (): void => {
      if (!shouldReleaseActionTask(task, chatInFlightRef.current)) return
      chatInFlightRef.current = null
    }
    void createConversation(id)
      .then(async (conversation) => {
        // 迟到的成功响应一律丢弃、不导航：A → B → A 时账号又等于 A，只比账号挡不住
        if (!isTaskLive(task, chatInFlightRef.current)) return
        await Taro.navigateTo({ url: `/pkg-social/pages/conversation/index?id=${conversation.id}` })
      })
      .catch((error: unknown) => {
        // 旧任务的失败不能弹给新账号。例外是**会话过期**（401）：`apiRequest` 就地清会话、
        // store 同步回到匿名，于是失败在守卫看来也是「迟到的」，可失败的正是本人 ——
        // 静默吞掉等于「点了聊一聊，什么都没发生」（同 `sendComment` 的口径）
        if (!isTaskLive(task, chatInFlightRef.current)) {
          if (shouldSurfaceStaleAuthFailure(isUnauthenticatedError(error), ownerRef.current)) {
            void Taro.showToast({ title: '请先登录后再聊一聊', icon: 'none' })
          }
          return
        }
        void Taro.showToast({
          title: isUnauthenticatedError(error) ? '请先登录后再聊一聊' : '会话发起失败，请重试',
          icon: 'none',
        })
      })
      .finally(release)
  }

  /**
   * 「立即购买」（#11 提案端点落地后的真接线）：打开自绘确认弹层，内容对齐 PC 站
   * `buy-dialog` —— 商品摘要 + 可改的交易金额 + 语义注释。确认后走真两步写：
   * `POST /conversations`（同买家同商品服务端**复用**既有会话，重复发起幂等）→
   * `POST /transactions/proposals`（往会话写一条 `tx.proposal`；商品仍是 `ACTIVE`，
   * 只有卖家接受才创建交易行，见 `features/transaction/api` 的提案注释）。
   *
   * 匿名**不弹层**：两个端点都挂 `requireAuth`，让匿名用户填完金额再吃 401 更糟 ——
   * 在入口就拦下。`unknown`（冷启动身份解析中）**放行**，与「聊一聊」同口径：
   * 任务铸定时已带上当刻登录态，`isTaskLive` 的冷启动豁免会兜住解析前后交错的
   * 迟到回调，把已登录用户拦在门外是误报。
   *
   * 金额默认带挂价、买家可改：这就是与卖家商定的成交价，卖家接受时以**卖家重传的值**
   * 为准（提案不落库，服务端无处可读）。免费送金额锁 0（0 元送没有可议的价）。
   */
  const openBuy = () => {
    if (buyRequested || buyBusy || buyInFlightRef.current !== null) return
    if (authStatus === 'anonymous') {
      void Taro.showToast({ title: '请先登录后再购买', icon: 'none' })
      return
    }
    // 详情没就位（骨架屏 / 失败态）不弹层：金额初值拿不到真值，发出去的提案没有依据
    if (listing === undefined) return
    setBuyAmount(initialAmountValue(listing.priceCents, listing.free))
    setBuyAmountError(null)
    setBuySubmitError(null)
    setBuyOpen(true)
  }

  /** 弹层的两个关闭口（蒙层 / 「再想想」）：提交在飞时不许关，PC 同款口径。 */
  const dismissBuy = () => {
    if (buyBusy) return
    setBuyOpen(false)
  }

  /**
   * 弹层「发起交易确认」：本地校验金额 → 两步写。
   *
   * 在飞锁与令牌口径同 `chatWithSeller`（另一把锁）：两步 `await` 的每个边界都先问
   * `isTaskLive`，等待期间换号 / 卸载后，A 的迟到响应不许写进 B 的页面、更不许压出
   * 会话页。两步合起来只持**一把**锁：第一步成功、第二步失败时用户重试，会从建会话
   * 重新走一遍 —— 建会话是幂等的（服务端复用），不会因此产生第二条提案以外的副作用。
   */
  const confirmBuy = () => {
    if (buyBusy || buyInFlightRef.current !== null || listing === undefined) return
    const fieldError = proposalAmountError(buyAmount, listing.free)
    if (fieldError !== null) {
      setBuyAmountError(fieldError)
      return
    }
    const cents = proposalAmountCents(buyAmount, listing.free)
    if (cents === null) return
    actionSeqRef.current += 1
    const task = beginActionTask(
      epochRef.current,
      ownerRef.current,
      actionSeqRef.current,
      authStatus,
    )
    buyInFlightRef.current = task.token
    const release = (): void => {
      if (!shouldReleaseActionTask(task, buyInFlightRef.current)) return
      buyInFlightRef.current = null
    }
    setBuyBusy(true)
    setBuyAmountError(null)
    setBuySubmitError(null)
    void (async () => {
      // 两步失败的文案不同源（PC 同款分档）：进到第二步才换映射器
      let step: 'conversation' | 'propose' = 'conversation'
      try {
        const conversation = await createConversation(id)
        if (!isTaskLive(task, buyInFlightRef.current)) return
        step = 'propose'
        await proposeTransaction(conversation.id, cents)
        if (!isTaskLive(task, buyInFlightRef.current)) return
        // 成功：进「待店家确认」终态并跳会话页（对齐 PC buy-dialog 的成功去向）——
        // 提案就是会话里的一条 `tx.proposal`，去会话能看到它，卖家也在那里接受
        setBuyRequested(true)
        setBuyOpen(false)
        void Taro.navigateTo({
          url: `/pkg-social/pages/conversation/index?id=${conversation.id}`,
        })
      } catch (error) {
        // 迟到的失败不写状态也不提示；例外是**会话过期**（401）：清会话后 store 已回
        // 匿名、这次失败在守卫看来是「迟到的」，可失败的就是本人（同 confirmOffline 口径）
        if (!isTaskLive(task, buyInFlightRef.current)) {
          if (shouldSurfaceStaleAuthFailure(isUnauthenticatedError(error), ownerRef.current)) {
            void Taro.showToast({ title: '请先登录后再购买', icon: 'none' })
          }
          return
        }
        if (isUnauthenticatedError(error)) {
          setBuySubmitError('登录已过期，请重新登录')
          return
        }
        if (step === 'conversation') {
          // 第一步（建会话）失败：走 `describeCreateConversationFailure`（只认
          // `LISTING_NOT_FOUND`；PC 站同名函数仍写「已下架」，小程序端已按契约订正）
          setBuySubmitError(describeCreateConversationFailure(error))
          return
        }
        const failure = describeProposeFailure(error)
        setBuySubmitError(failure.message)
        if (failure.refresh) {
          /*
            商品已不在售是状态漂移：**弹层留着**展示这条错误、页面重取详情
            （PC 的 `onListingStale` → `detail.refetch()` 同款）。

            ⚠️ 必须走**静默**的 `refresh()`，不能走 `load()`：`load()` 会先
            `setData(null)` 回骨架屏，而弹层的摘要读的是实时 listing —— 重取期间它
            会对着用户写「挂价 ¥0」（真实挂价可能几百上千），确认钮也会因为
            `listing === undefined` 变成点了没反应。`refresh()` 保留现有内容，
            只有服务端明确说商品没了才切空态。
          */
          refresh()
        }
      } finally {
        // 先判再放锁：release 之后 `isTaskLive` 必为假，会把「正在发起…」永远卡住
        const stillOurs = isTaskLive(task, buyInFlightRef.current)
        release()
        if (stillOurs) setBuyBusy(false)
      }
    })()
  }

  /* ------------------------------------------------------ 卖家视角底栏动作 */

  /**
   * 「管理」：两项动作（Owner 2026-09-27 拍板：编辑 / 下架，没有第三项）。
   * 原生 ActionSheet 够用，不自绘面板；二改要换样式再说。
   *
   * 令牌在**弹出之前**捕获（同 `chatWithSeller` / `buy` 的 `ActionTask` 口径，
   * 见 `./view`）：弹出层的结果是跨帧回调，等待期间换号 / 退出 / 卸载
   * 之后，A 的 `tapIndex` 仍会去写编辑交接、`switchTab` 或给已经清场的页面重开卖家下架卡
   * —— 这三步都在服务器任何校验**之前**，商品归属校验挡不住。所以回调里先问
   * `isTaskLive`，过期就整条丢弃。
   */
  const manageListing = () => {
    // 在飞时再点：不弹第二张。换号时锁在这里被置 `null`，A 的迟到回调因此连令牌都对不上
    if (menuInFlightRef.current !== null) return
    actionSeqRef.current += 1
    const task = beginActionTask(
      epochRef.current,
      ownerRef.current,
      actionSeqRef.current,
      authStatus,
    )
    menuInFlightRef.current = task.token
    /** 只释放自己的锁：换号后 B 重新弹层时，A 的迟到收尾不能删掉 B 的标记 */
    const release = (): void => {
      if (!shouldReleaseActionTask(task, menuInFlightRef.current)) return
      menuInFlightRef.current = null
    }
    void Taro.showActionSheet({ itemList: ['编辑', '下架'] })
      .then((res) => {
        // 迟到的结果一律丢弃、不产生任何副作用：A → B → A 时账号名又相等，只比账号名挡不住
        if (!isTaskLive(task, menuInFlightRef.current)) return
        if (res.tapIndex === 0) {
          // 与我的发布页同一条交接：出物页是 Tab 页不能带 query（`edit-target` 模块说明），
          // 出物页取到交接后进编辑态并回填原商品信息
          requestSellEdit(id)
          void Taro.switchTab({ url: '/pages/sell/index' })
        } else if (res.tapIndex === 1) {
          setOfflineSubmit('idle')
          setOfflineConfirmOpen(true)
        }
      })
      // 点遮罩 / 「取消」的 reject 不是错误，静默收场
      .catch(() => {})
      .finally(release)
  }

  /**
   * 「看谁想要」：只统计已发起聊天的买家（#214 的口径），页内自带非本人守卫，
   * 非卖家打开会落在它自己的空态。
   */
  const goWatchers = () => {
    void Taro.navigateTo({ url: `/pkg-browse/pages/watchers/index?listingId=${id}` })
  }

  /** 非在售状态行的去处：编辑 / 重新上架这些管理动作都收在「我的发布」里 */
  const goMyList = () => {
    void Taro.navigateTo({ url: '/pkg-browse/pages/mylist/index' })
  }

  /**
   * 「下架」确认卡：与我的发布页同一真状态机（默认可点 / 下架中 / 失败重试），
   * 失败停在弹层里给「重试」，成功后静默刷新详情 —— 状态行以服务端真值为准，
   * 不本地假改 `status`。
   */
  const confirmOffline = () => {
    // 在飞守卫是**令牌**而不是布尔（同 `chatInFlightRef` / mylist 的 confirmOffline）：
    // 布尔锁下 A 的迟到 `finally` 会把 B（或 A 自己下一轮）的在飞标记一并删掉，
    // 于是同一件商品被重复下架、弹层里还会看到矛盾的「下架中 / 失败」。
    // 挡下来时给一句提示：卡片是「关掉再打开」就回到可点态，光 `return` 会变成点了没反应。
    if (offlineInFlightRef.current !== null) {
      void Taro.showToast({ title: '正在下架，请稍候', icon: 'none' })
      return
    }
    // 与底栏另两个动作同一把尺：铸任务（账号 + 世代 + 令牌）+ 记入航班，回调里问
    // `isTaskLive`，换号 / 卸载后迟到的下架不许写进 B 的页面
    actionSeqRef.current += 1
    const task = beginActionTask(
      epochRef.current,
      ownerRef.current,
      actionSeqRef.current,
      authStatus,
    )
    offlineInFlightRef.current = task.token
    /** 只释放自己那把锁（同 `release`）：令牌已经被换号清场或下一轮请求换掉时不动它 */
    const release = (): void => {
      if (!shouldReleaseOfflineTask(task.token, offlineInFlightRef.current)) return
      offlineInFlightRef.current = null
    }
    reloadRef.current = beginReloadWrite(reloadRef.current, task.epoch)
    setOfflineSubmit('busy')
    void (async () => {
      try {
        await offlineListing(id)
        if (!isTaskLive(task, offlineInFlightRef.current)) return
        setOfflineSubmit('idle')
        setOfflineConfirmOpen(false)
        void Taro.showToast({ title: '已下架', icon: 'none' })
        // 刷新本身也可能被并发的留言写入延后，走同一套记账
        requestRefresh()
      } catch (error) {
        // 迟到失败不写状态也不提示；例外是**会话过期**（401）：清会话后 store 已回
        // 匿名、这次失败在守卫看来是「迟到的」，可失败的就是本人 —— 静默吞掉等于
        // 「点了确认下架，什么都没发生」（同 sendComment 的口径，见 `./view`）
        if (!isTaskLive(task, offlineInFlightRef.current)) {
          if (shouldSurfaceStaleAuthFailure(isUnauthenticatedError(error), ownerRef.current)) {
            void Taro.showToast({ title: '下架失败，请重试', icon: 'none' })
          }
          return
        }
        setOfflineSubmit('failed')
        void Taro.showToast({
          title: isApiError(error) ? error.message || '下架失败，请重试' : '下架失败，请重试',
          icon: 'none',
        })
      } finally {
        release()
        finishWrite(task.epoch)
      }
    })()
  }

  /**
   * 发一条顶层留言：先乐观插入本页 state，再用服务端返回值替换掉本地占位。
   *
   * 失败口径（#111 后端已落地）：**明确失败必须回滚**并弹提示 ——
   * 尤其 422 审核拒绝不能让违规文本继续以正常留言样式留在页面上。
   */
  const sendComment = () => {
    const content = commentInput.trim()
    if (!content) return
    // 铸任务必须在发请求**之前**：之后换号也能凭 epoch 把这次写入（连同回调里的
    // setState 与 toast 副作用）整条作废，而不是写进下一个账号的页面（判据 C）
    const task = beginTask(epochRef.current, ownerRef.current)
    // 在途写入的账也在发请求**之前**记下，且记在当前账号这一代上：返回刷新要等它结算
    reloadRef.current = beginReloadWrite(reloadRef.current, task.epoch)
    // 先算好再进 updater：updater 必须是纯函数，在里面自增 `localSeq` 会带副作用
    const pending = localComment(content)
    setComments((prev) => [pending, ...prev])
    setCommentInput('')
    void postComment(id, content)
      .then((created) => {
        if (!isTaskCurrent(task, epochRef.current, ownerRef.current)) return
        // 用真实 DTO 换掉占位：拿到真实 id 后才能对它发起回复。
        setComments((prev) =>
          prev.map((node) => (node.id === pending.id ? dtoToNode(created) : node)),
        )
      })
      .catch((error) => {
        // 迟到失败不回滚也不弹提示：占位已随换号清场作废，提示该弹在发起它的账号上。
        // 例外是**会话过期**（401）：`apiRequest` 会就地清会话、store 同步回到匿名，
        // 于是这次失败在守卫看来也是「迟到的」，可失败的正是本人 —— 静默吞掉等于
        // 「点了发送，什么都没发生」，那种情况仍要把失败说出来（见 `./view`）
        if (!isTaskCurrent(task, epochRef.current, ownerRef.current)) {
          if (shouldSurfaceStaleAuthFailure(isUnauthenticatedError(error), ownerRef.current)) {
            notifyCommentFailure('留言', error)
          }
          return
        }
        // 回滚本地占位 + 可见反馈；不回滚就会把失败说成成功。
        setComments((prev) => prev.filter((node) => node.id !== pending.id))
        notifyCommentFailure('留言', error)
      })
      .finally(() => {
        finishWrite(task.epoch)
      })
  }

  /** 回复某条顶层留言：同样先乐观插入，服务端确认后替换，失败回滚并提示 */
  const sendReply = (commentId: string) => {
    const content = replyInput.trim()
    if (!content) return
    // 同 `sendComment`：任务与在途写入的账都先记，换号后整条写入连同副作用一起作废
    const task = beginTask(epochRef.current, ownerRef.current)
    reloadRef.current = beginReloadWrite(reloadRef.current, task.epoch)
    const pending = localComment(content)
    setComments((prev) =>
      prev.map((node) =>
        node.id === commentId ? { ...node, replies: [...node.replies, pending] } : node,
      ),
    )
    setReplyInput('')
    setReplyTo(null)
    void postReply(commentId, content)
      .then((created) => {
        if (!isTaskCurrent(task, epochRef.current, ownerRef.current)) return
        const reply = dtoToNode(created)
        setComments((prev) =>
          prev.map((node) =>
            node.id === commentId
              ? {
                  ...node,
                  replies: node.replies.map((entry) => (entry.id === pending.id ? reply : entry)),
                }
              : node,
          ),
        )
      })
      .catch((error) => {
        // 会话过期的例外同 `sendComment`：失败的是本人，必须说出来
        if (!isTaskCurrent(task, epochRef.current, ownerRef.current)) {
          if (shouldSurfaceStaleAuthFailure(isUnauthenticatedError(error), ownerRef.current)) {
            notifyCommentFailure('回复', error)
          }
          return
        }
        setComments((prev) =>
          prev.map((node) =>
            node.id === commentId
              ? { ...node, replies: node.replies.filter((entry) => entry.id !== pending.id) }
              : node,
          ),
        )
        notifyCommentFailure('回复', error)
      })
      .finally(() => {
        finishWrite(task.epoch)
      })
  }

  /** 点「回复」：再点同一条收起（稿子行为），换一条则把输入行挪过去并清空 */
  const toggleReply = (commentId: string) => {
    setReplyInput('')
    setReplyTo((prev) => (prev === commentId ? null : commentId))
  }

  /**
   * 展开 / 收起留言。
   *
   * 展开只揭示**已经取到**的那一页；后面还有多少由列表底部的「加载更多」按需取。
   * 旧实现在这里串行把剩余页拉满（最多 20 页 × 50 条）再一次 `setComments` 推入 ——
   * 真机上单次 setData 1000 条会明显卡，且用户没翻到底也付了全部流量。
   */
  const toggleComments = () => {
    setCommentsOpen((prev) => !prev)
  }

  /**
   * 「加载更多」：点一次取**下一页**并追加，不做自动无限滚动。
   *
   * - 重入守卫用 ref：`loadingMore` state 更新是异步的，连点两次会都读到旧值，
   *   两次请求各自 append 就会把同一页留言叠两遍。
   * - 追加前确认读取世代没被重试 / 返回刷新顶掉：翻页途中若有重来过，这一批是按旧列表
   *   （旧游标）拼的，落进去同样会重复。
   * - 失败只留痕、不收起列表：游标原样不动（一条也没追加），用户再点一次就是重试。
   *   旧实现是「展开即一次拉完」，失败只能整块收起来重来。
   * - 服务端若违约把同一个游标再发回来（新游标与出发时那个字符串相同），就按末页处理：
   *   旧实现有 20 页上限兜底，这里没有循环可兜，只能靠这条判据止住重复追加。
   * - `commentsCursor` 为 `null` = 已到末页，按钮随之消失（本页没有「没有更多」文案，
   *   也就不新造）。
   */
  const loadMoreComments = async () => {
    const cursor = commentsCursor
    if (!cursor || loadingMoreRef.current) return

    loadingMoreRef.current = true
    setLoadingMore(true)
    // 记住出发时的读取世代
    const seq = loadSeqRef.current
    try {
      const page = await fetchComments(id, cursor)
      if (!mountedRef.current) return
      if (!isLatestLoad(seq, loadSeqRef.current)) return
      const next = page.nextCursor
      // 游标没前进 = 服务端在重复给同一页（`pkg-browse/pages/mylist/pending.ts:153` 同一判据）：
      // 这一批就是刚才那批，append 上去只会多出一页重复行 —— 丢掉它、按末页收口，按钮随之下线。
      if (next === cursor) {
        setCommentsCursor(null)
        return
      }
      setComments((prev) => [...prev, ...page.items.map(dtoToNode)])
      setCommentsCursor(next)
    } catch (error) {
      logCommentFailure('更多留言', error)
    } finally {
      loadingMoreRef.current = false
      if (mountedRef.current) setLoadingMore(false)
    }
  }

  const listing = data?.listing
  const images = listing?.images ?? []
  const visibleComments = commentsOpen ? comments : comments.slice(0, COMMENT_LIMIT)
  const paragraphs = listing ? descriptionLines(listing.description) : []

  /**
   * #252：站内举报入口。此前「举报走微信胶囊菜单」只是稿的取舍，站内并没有举报能力。
   * 仅**非本人商品**显示（本人商品不需要举报自己）；未登录时由举报页的 useAuthGuard
   * 引导登录。对象四项由 query 带入、页内不可改。`id` 传 `listing.id`，即契约
   * `ListingCardSchema.id` = `ListingIdSchema` 的 `lst_` 公开 ID（`packages/contracts/src/listings/schema.ts`），
   * 举报页会用 `ListingIdSchema.safeParse` 硬校验后才 POST /reports —— 裸 UUID 到不了公开 API。
   * 商品编号不在页内展示（#217：详情页不常驻展示编号）。
   *
   * 「是不是本人」统一取上面的 `ownListing`（#274 的 `ownerViewUserId` 口径：演示构建
   * 会把当前登录 uuid 换成 mock 世界的「我」）。本页曾另立一个直接比 `userId` 的局部
   * 变量，与 `./view` 里同名的 `isOwnListing` 谓词撞在同一作用域，合并后会把上面那次
   * 调用压进 TDZ —— 现在只剩一个归属判据。
   */
  const goReport = () => {
    if (!data || !listing) return
    const query = [
      `id=${encodeURIComponent(listing.id)}`,
      `title=${encodeURIComponent(listing.title)}`,
      `price=${encodeURIComponent(formatAmount(listing.priceCents))}`,
      images[0] ? `cover=${encodeURIComponent(images[0])}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join('&')
    void Taro.navigateTo({ url: `/pkg-trade/pages/report-listing/index?${query}` })
  }

  return (
    <View className="detail">
      {/*
        吸顶导航：只有返回钮是实体。
        底色分两态 —— 页面在顶部时整条栏透明（返回钮浮在商品图上，与稿子一致），
        滑过图集后 `.is-solid` 才长出磨砂底 + 底部描边（过渡见 index.scss）。
      */}
      <View
        className={`detail__nav${navSolid ? ' is-solid' : ''}`}
        style={{ paddingTop: `${metrics.statusBarHeight}px` }}
      >
        {/*
          行几何与 `components/top-bar` 同构：行总高 = totalHeight，多出胶囊行的
          部分 padding-bottom 补在下方 —— 返回钮在胶囊那一段（contentHeight）里
          居中，与右侧原生胶囊**等高、同轴**（2026-10-02 拍板）。
        */}
        <View
          className="detail__navrow"
          style={{
            height: `${metrics.totalHeight - metrics.statusBarHeight}px`,
            paddingBottom: `${metrics.totalHeight - metrics.statusBarHeight - metrics.contentHeight}px`,
          }}
        >
          <View className="detail__back" style={backGeo.btnStyle} onClick={handleBack}>
            <View className="detail__chevron" style={backGeo.chevronStyle} />
          </View>
        </View>
      </View>

      {loadState === 'failed' ? (
        /* 真接口失败：明确错误态 + 重试。按 loadState 分支，不会再被骨架屏分支吞掉（#121） */
        <View className="detail__emptypad">
          <LoadError
            title="加载失败"
            text="没能取到这件商品。检查网络或后端地址后重试"
            onRetry={load}
          />
        </View>
      ) : loadState === 'notFound' ? (
        /* 商品不存在 / 已下架（相似推荐、通知、旧分享链接都可能指过来）：按状态走空态，
           不留无限骨架屏，也不拿 mock 商品顶替（#121） */
        <View className="detail__emptypad">
          <EmptyState
            title="商品不存在或已下架"
            text="这件闲置可能已被卖家删除或下架了，去看看别的吧"
          />
        </View>
      ) : loadState === 'ok' && data && listing ? (
        /*
          白卡（`.detail__sections`）到留言区就结束 —— 稿子里的圆角与投影挂在这块白卡上，
          「同类推荐」在卡外，所以它是兄弟节点而不是子节点。放进去的话，白底会把圆角切掉的
          两个角填白、把投影盖掉（两者都实测不可见）。
        */
        <>
          <View className="detail__sections">
            {/* ---------------------------------------------------- 图集 */}
            <View className="detail__gallery">
              {images.length > 0 ? (
                <Swiper
                  className="detail__swiper"
                  circular
                  current={slide}
                  onChange={(event) => {
                    const index = event.detail.current
                    setSlide(index)
                    /*
                      R1 §3.5：用户主动切图发 IMAGE_VIEW（含点圆点），首屏自动展示第一张不算。
                      `slideRef` 是上一次上报过的下标，初始化那次下标与它相等，于是不发 ——
                      比时间窗更准（不需要猜视图层什么时候会补一次 onChange）。
                    */
                    if (index === slideRef.current) return
                    slideRef.current = index
                    trackRecommendationEvent({
                      listingId: listing.id,
                      eventType: 'IMAGE_VIEW',
                      attribution,
                      metadata: { imageIndex: index },
                    })
                  }}
                >
                  {images.map((url) => (
                    <SwiperItem key={url} className="detail__slide">
                      <Image className="detail__slide-img" src={url} mode="aspectFill" />
                    </SwiperItem>
                  ))}
                </Swiper>
              ) : (
                <View className="detail__slide-ph">
                  <Text className="detail__slide-ph-text">暂无商品图</Text>
                </View>
              )}

              <View className="detail__dots">
                {images.map((url, index) => (
                  <View
                    key={url}
                    className={`detail__dot${index === slide ? ' is-on' : ''}`}
                    onClick={() => setSlide(index)}
                  />
                ))}
              </View>
            </View>

            {/* ---------------------------------------------------- 价格 / 标题 */}
            <View className="detail__meta">
              <View className="detail__priceline">
                <View className="detail__price">
                  <Text className="detail__price-cur">¥</Text>
                  <Text className="detail__price-amt">{formatAmount(listing.priceCents)}</Text>
                </View>
                {listing.originalPriceCents ? (
                  <Text className="detail__was">
                    {`原价 ¥${formatAmount(listing.originalPriceCents)}`}
                  </Text>
                ) : null}
              </View>

              <Text className="detail__title">{listing.title}</Text>
              <Text className="detail__spec">{listing.spec}</Text>

              <View className="detail__stats">
                <Text className="detail__posted">{postedLabel(listing.createdHoursAgo)}</Text>
                <View className="detail__metrics">
                  {/* 两个计数都来自契约：`views` = 近 30 天去重浏览人数、`wants` = 已建会话的买家数
                      （口径见 `ListingCardSchema` 上各自的注释）。真数据下两者恒有值；
                      保留 `null` 分支是为了演示 fixture 与旧记录 —— 宁可整块不画，也不显示 0。
                      「近 30 天」必须画出来：`wants` 是累计、`views` 是滚动窗口，同一行并排
                      （例「浏览 3 · 想要 12」）只有标出窗口才不会被读成同一个量纲。 */}
                  {listing.views === null ? null : (
                    <Text className="detail__metric">
                      <Text className="detail__metric-num">{listing.views}</Text>
                      <Text> 浏览</Text>
                      <Text className="detail__metric-win">（近 30 天）</Text>
                    </Text>
                  )}
                  {listing.wants === null ? null : (
                    <Text className="detail__metric">
                      <Text className="detail__metric-num">{listing.wants}</Text>
                      <Text> 想要</Text>
                    </Text>
                  )}
                </View>
              </View>
            </View>

            {/* ---------------------------------------------------- 描述 */}
            <View className="detail__desc">
              {paragraphs.map((line) => (
                <Text key={line} className="detail__para">
                  {line}
                </Text>
              ))}
              {/*
              描述标签：三项**全部从既有字段派生**，契约里没有 tags 字段（也不打算加）。
              可小刀只在卖家开了议价时出现 —— 没有这个字段就说没有，不编一个标签。
            */}
              <View className="detail__tags">
                <Text className="detail__tag">{categoryLabel(listing.category)}</Text>
                <Text className="detail__tag">{conditionLabel(listing.condition)}</Text>
                {listing.negotiable ? <Text className="detail__tag">可小刀</Text> : null}
                {/* #252：举报入口挂在标签行右端（Owner 2026-09-26：与 tag 同排、右边对齐）。
                    仅非本人商品显示；ownListing / goReport 见组件内注释。 */}
                {!ownListing ? (
                  <View className="detail__tag-report" onClick={goReport}>
                    <Text>举报</Text>
                  </View>
                ) : null}
              </View>
            </View>

            {/* ---------------------------------------------------- 卖家 */}
            <View className="detail__seller-section">
              <View className="detail__seller">
                <Image className="detail__avatar" src={data.seller.avatarUrl} mode="aspectFill" />
                <View className="detail__sinfo">
                  {/* 昵称行只有昵称 + 认证勾（稿子口径）：校区不在这里显示 */}
                  <View className="detail__sname">
                    <Text className="detail__snick">{data.seller.nickname}</Text>
                    {data.seller.authStatus === 'VERIFIED' ? (
                      <Image className="detail__stick" src={ICONS.checkMuted} mode="aspectFit" />
                    ) : null}
                    {/* 在线态（#359 第五点）：昵称行里紧挨昵称（认证勾之后）、头像右侧的
                        同一条水平线上（与稿 `.seller .nm` 的排布一致，右侧那个独立槽位是
                        「进TA主页」）。
                        绿点 + 文案（离线时说「多久没上线」，见 features/presence/view）。 */}
                    {sellerPresence ? (
                      <View
                        className={`detail__presence${sellerPresence.online ? ' is-online' : ''}`}
                      >
                        <View className="detail__presence-dot" />
                        <Text className="detail__presence-tx">{sellerPresence.text}</Text>
                      </View>
                    ) : null}
                  </View>
                  {/*
                  卖出件数与好评率契约里没有（见 mock/types.ts 的 MockUser 注释）。
                  真实数据下两者都是 null，此时整行不渲染 —— 不编「卖出 0 件 · 好评率 0%」。
                */}
                  {data.seller.soldCount !== null || data.seller.goodRate !== null ? (
                    <View className="detail__ssub">
                      {data.seller.soldCount !== null ? (
                        <Text>{`卖出 ${data.seller.soldCount} 件`}</Text>
                      ) : null}
                      {data.seller.soldCount !== null && data.seller.goodRate !== null ? (
                        <Text>·</Text>
                      ) : null}
                      {data.seller.goodRate !== null ? (
                        <Text>{`好评率 ${data.seller.goodRate}%`}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                {/* #122：他人主页已接真实公开资料，这里不再是 toast 占位。
                    跳转带 `seller.id`（契约 `ListingDetail.seller.id`），与页面顶部卖家行同一来源。 */}
                <View
                  className="detail__go"
                  onClick={() =>
                    void Taro.navigateTo({
                      url: `/pkg-browse/pages/user/index?id=${data.seller.id}`,
                    })
                  }
                >
                  <Text>进TA主页</Text>
                  <Image
                    className="detail__go-img"
                    src={ICONS.chevronRightMuted}
                    mode="aspectFit"
                  />
                </View>
              </View>
            </View>

            {/* ---------------------------------------------------- 谁在求购 */}
            {/*
              卖家视角专属（#8 byListing）：谁求购过跟我这件商品匹配的愿望。
              `matches === null`（非本人 / 拉取失败）或没人求购时整块不渲染 ——
              只剩一个标题的空壳区块比没有区块更奇怪。行点击去搜索页搜该关键词
              （与许愿页「按关键词搜索」同一跳转口径）。
            */}
            {ownListing && matches !== null && matches.items.length > 0 ? (
              <View className="detail__matches">
                <View className="detail__seclabel">
                  <Image className="detail__seclabel-img" src={ICONS.heartMuted} mode="aspectFit" />
                  <Text>{`谁在求购 · ${matches.total}`}</Text>
                </View>
                <View className="detail__match-list">
                  {matches.items.map((match) => (
                    <View
                      key={match.id}
                      className="detail__match"
                      onClick={() =>
                        void Taro.navigateTo({
                          url: `/pkg-browse/pages/search/index?q=${encodeURIComponent(match.wish.keyword)}`,
                        })
                      }
                    >
                      <View className="detail__match-main">
                        <Text className="detail__match-kw">{match.wish.keyword}</Text>
                        <Text className="detail__match-sub">{matchBudgetText(match.wish)}</Text>
                      </View>
                      <Text className="detail__match-score num">{`${match.score}%`}</Text>
                    </View>
                  ))}
                </View>
                {/*
                  `total` 是阈值过滤后的**全量**条数，`items` 只是这一页（本页每次按
                  `MATCH_LIMIT_MAX = 50` 满额取，见 features/match/api.ts 的默认上限）
                  —— 契约明写两者不该互相推导。并排摆着「谁在求购 · 25」却只有几行，
                  会被读成「这 25 位都在下面」，所以差额要如实说清。
                */}
                {matches.total > matches.items.length ? (
                  <Text className="detail__match-sub">
                    {`共 ${matches.total} 位，显示前 ${matches.items.length} 位`}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* ---------------------------------------------------- 留言 */}
            <View className="detail__comments">
              {/* 输入条：稿子画在留言区顶部，负 margin 抵掉区块左右 padding 铺满整宽 */}
              <View className="detail__cmt-bar">
                <View className="detail__cmt-me">
                  <Text className="detail__cmt-me-text">我</Text>
                </View>
                <Input
                  className="detail__cmt-in"
                  value={commentInput}
                  type="text"
                  placeholder="说点什么…"
                  placeholderClass="detail__cmt-ph"
                  confirmType="send"
                  onInput={(event) => setCommentInput(event.detail.value)}
                  onConfirm={sendComment}
                />
                <View className="detail__cmt-send" onClick={sendComment}>
                  <Text>发送</Text>
                </View>
              </View>

              {comments.length === 0 ? (
                <Text className="detail__cmt-empty">还没有人留言，来问一句吧</Text>
              ) : (
                <>
                  <View className="detail__cmts">
                    {visibleComments.map((comment) => (
                      <View key={comment.id} className="detail__cmt">
                        <View className="detail__cav">
                          <Text className="detail__cav-text">{comment.authorInitial}</Text>
                        </View>
                        <View className="detail__cbody">
                          <View className="detail__chd">
                            <Text className="detail__cn">{comment.authorName}</Text>
                            {comment.isSeller ? <Text className="detail__ctag">卖家</Text> : null}
                            <Text className="detail__ct">{comment.timeLabel}</Text>
                          </View>
                          <Text className="detail__cx">{comment.content}</Text>

                          <View className="detail__creply" onClick={() => toggleReply(comment.id)}>
                            <Text>回复</Text>
                          </View>

                          {/* 行内回复输入行：稿子同时只开一行，插在回复列表之前 */}
                          {replyTo === comment.id ? (
                            <View className="detail__creply-row">
                              <Input
                                className="detail__cmt-in detail__cmt-in--reply"
                                value={replyInput}
                                type="text"
                                focus
                                placeholder={`回复 ${comment.authorName}…`}
                                placeholderClass="detail__cmt-ph"
                                confirmType="send"
                                onInput={(event) => setReplyInput(event.detail.value)}
                                onConfirm={() => sendReply(comment.id)}
                              />
                              <View
                                className="detail__cmt-send detail__cmt-send--reply"
                                onClick={() => sendReply(comment.id)}
                              >
                                <Text>回复</Text>
                              </View>
                            </View>
                          ) : null}

                          {comment.replies.length > 0 ? (
                            <View className="detail__replies">
                              {comment.replies.map((reply) => (
                                <View key={reply.id} className="detail__cmt detail__cmt--reply">
                                  <View className="detail__cav detail__cav--reply">
                                    <Text className="detail__cav-text">{reply.authorInitial}</Text>
                                  </View>
                                  <View className="detail__cbody">
                                    <View className="detail__chd">
                                      <Text className="detail__cn">{reply.authorName}</Text>
                                      {reply.isSeller ? (
                                        <Text className="detail__ctag">卖家</Text>
                                      ) : null}
                                      <Text className="detail__ct">{reply.timeLabel}</Text>
                                    </View>
                                    <Text className="detail__cx">{reply.content}</Text>
                                  </View>
                                </View>
                              ))}
                            </View>
                          ) : null}
                        </View>
                      </View>
                    ))}
                  </View>

                  {/* 分页脚：点一次取下一页（`commentsCursor` 为 `null` = 已到底，按钮消失）。
                      复用「查看全部 / 收起」那款文字链样式，不新增视觉。 */}
                  {commentsOpen && commentsCursor ? (
                    <View className="detail__cmt-more" onClick={() => void loadMoreComments()}>
                      <Text className="detail__cmt-more-text">
                        {loadingMore ? '正在加载…' : '加载更多'}
                      </Text>
                    </View>
                  ) : null}

                  {/* 计数按**顶层**留言算（稿子的 topCmts 口径），嵌套回复不计数。
                      `commentsCursor` 非空 = 还有下一页未拉，此时加 `+` 不把“已知条数”
                      说成“全部条数”（否则 51 条会显示“查看全部 50 条”）。 */}
                  {comments.length > COMMENT_LIMIT || commentsCursor ? (
                    <View className="detail__cmt-more" onClick={() => void toggleComments()}>
                      <Text className="detail__cmt-more-text">
                        {commentsOpen
                          ? '收起留言'
                          : `查看全部 ${comments.length}${commentsCursor ? '+' : ''} 条留言`}
                      </Text>
                      <Image
                        className={`detail__cmt-more-img${commentsOpen ? ' is-open' : ''}`}
                        src={ICONS.chevronDownMuted}
                        mode="aspectFit"
                      />
                    </View>
                  ) : null}
                </>
              )}
            </View>
          </View>

          {/* ---------------------------------------------------- 同类推荐 */}
          {/* 一件能推的都没有时整块不渲染：只剩一个「同类推荐」标题是空壳 */}
          {visibleSimilarCount === 0 ? null : (
            <View className="detail__similar">
              <View className="detail__seclabel">
                <Image className="detail__seclabel-img" src={ICONS.category} mode="aspectFit" />
                <Text>同类推荐</Text>
              </View>

              <View className="detail__waterfall">
                <View className="detail__wf-col">
                  {/* 卡片自带点击 → `navigateTo('/pages/listing-detail/index?id=' + id)`，
                      这里不再包一层 onClick，避免同一次点击 push 两次路由 */}
                  {leftSimilar.map((item) => (
                    <ProductCard
                      key={item.id}
                      listing={item}
                      /*
                        卖家用**这张卡自己内嵌的** seller，不能用 `data.seller`。
                        `data.seller` 是**当前这件商品**的卖家；相似推荐是别人的商品，
                        把当前卖家挂上去就是给别人的商品捏造了一个卖家。
                        #191 起契约卡片内嵌 `seller`（`toMockListing` 同源投影）：
                        真实数据下是这张卡的卖家真值；老 mock 记录缺席时是 null → 整行不渲染。
                      */
                      seller={item.seller}
                      imageHeight={RATIO_HEIGHT[item.ratio]}
                      /* 卡片就地不渲染；页面这份名单管跨页同步与「还有没有内容可推荐」 */
                      hidden={hiddenSimilar.includes(item.id)}
                      onDislike={() => setHiddenSimilar((prev) => [...prev, item.id])}
                    />
                  ))}
                </View>
                <View className="detail__wf-col">
                  {rightSimilar.map((item) => (
                    <ProductCard
                      key={item.id}
                      listing={item}
                      /* 同左列：用卡片自己内嵌的 seller，不用当前商品的卖家 */
                      seller={item.seller}
                      imageHeight={RATIO_HEIGHT[item.ratio]}
                      hidden={hiddenSimilar.includes(item.id)}
                      onDislike={() => setHiddenSimilar((prev) => [...prev, item.id])}
                    />
                  ))}
                </View>
              </View>
            </View>
          )}
        </>
      ) : (
        /* 仍在加载：骨架屏。这个分支只应在 loadState === 'loading' 时到达 ——
           `ok` 时 data / listing 必已就位（在 load() 里一起置位） */
        <View className="detail__skeleton">
          <View className="detail__sk-gallery" />
          <View className="detail__sk-line detail__sk-line--lg" />
          <View className="detail__sk-line" />
          <View className="detail__sk-line detail__sk-line--sm" />
          <View className="detail__sk-block" />
        </View>
      )}

      {/* ---------------------------------------------------- 底部操作栏 */}
      {/*
        买家形态（Owner 拍板的主次）：「聊一聊」为主（品牌实底，占右侧拇指位）、
        「立即购买」为次（浅底描边）—— 即原来的 solid/ghost 互换。购买已确认后按钮
        转灰为状态牌，点击无效果（buy 里守卫）。
        卖家形态（Owner 2026-09-27 拍板）：当前账号是卖家时换成「管理 / 看谁想要」，
        收藏心不出现（卖家不收藏自己的商品）；非在售不渲染操作钮，整条换状态行
        （见 view.ownerStatusNote）。举报入口在标签行（#260），与本栏无关。
      */}
      <View className="detail__bar">
        {ownListing && ownerNote === null ? (
          <>
            <View className="detail__btn detail__btn--ghost" onClick={manageListing}>
              <Image className="detail__btn-img" src={ICONS.settingsMuted} mode="aspectFit" />
              <Text>管理</Text>
            </View>
            <View className="detail__btn detail__btn--solid" onClick={goWatchers}>
              <Image className="detail__btn-img" src={ICONS.heartWhite} mode="aspectFit" />
              <Text>看谁想要</Text>
            </View>
          </>
        ) : ownListing && ownerNote !== null ? (
          <View className="detail__bar-note">
            <Text className="detail__bar-note-text">{ownerNote}</Text>
            <Text className="detail__bar-note-link" onClick={goMyList}>
              去我的发布管理
            </Text>
          </View>
        ) : (
          <>
            <View className={`detail__fav${faved ? ' is-on' : ''}`} onClick={toggleFavorite}>
              <Image
                className="detail__fav-img"
                src={faved ? ICONS.heartOn : ICONS.heartMuted}
                mode="aspectFit"
              />
            </View>
            <View
              className={`detail__btn detail__btn--ghost${
                buyRequested ? ' detail__btn--pending' : ''
              }`}
              onClick={openBuy}
            >
              {buyRequested ? null : (
                <Image className="detail__btn-img" src={ICONS.heartOn} mode="aspectFit" />
              )}
              <Text>{buyRequested ? '待店家确认' : '立即购买'}</Text>
            </View>
            <View className="detail__btn detail__btn--solid" onClick={chatWithSeller}>
              <Image className="detail__btn-img" src={ICONS.chatWhite} mode="aspectFit" />
              <Text>聊一聊</Text>
            </View>
          </>
        )}
      </View>

      {/* ---------------- 下架二次确认（卖家视角，同我的发布页的三态卡） ---------------- */}
      {offlineConfirmOpen ? (
        <>
          <View className="detail__scrim" onClick={() => setOfflineConfirmOpen(false)} />
          <View className="detail__dialog">
            <Text className="detail__dialog-title">确认下架这件商品？</Text>
            <Text className="detail__dialog-sub">
              下架后买家在首页与搜索里都看不到它，已有的会话不受影响。
            </Text>
            <View className="detail__dlg-tip">
              <Text>
                下架是可恢复操作：之后在「我的发布」的「已下架」里点「重新上架」，即可把商品信息带进出物页重新发布。
              </Text>
            </View>
            <View className="detail__dlg-acts">
              <View
                className="detail__dlg-cancel"
                onClick={() => {
                  setOfflineConfirmOpen(false)
                  setOfflineSubmit('idle')
                }}
              >
                <Text>取消</Text>
              </View>
              <View
                className={`detail__dlg-ok${offlineSubmit === 'busy' ? ' is-busy' : ''}${
                  offlineSubmit === 'failed' ? ' is-failed' : ''
                }`}
                onClick={confirmOffline}
              >
                {offlineSubmit === 'busy' ? <View className="detail__spin" /> : null}
                <Text>
                  {offlineSubmit === 'busy'
                    ? '下架中'
                    : offlineSubmit === 'failed'
                      ? '重试'
                      : '确认下架'}
                </Text>
              </View>
            </View>
          </View>
        </>
      ) : null}

      {/* ------- 「立即购买」确认弹层（对齐 PC buy-dialog：商品摘要 + 可改金额 + 注释） ------- */}
      {buyOpen ? (
        <>
          <View className="detail__scrim" onClick={dismissBuy} />
          <View className="detail__dialog">
            <Text className="detail__dialog-title">确定立即购买</Text>
            <Text className="detail__dialog-sub">
              确认后会给卖家发一条交易确认，卖家同意才会生成订单并锁定商品。
            </Text>
            <View className="detail__buy-goods">
              <Text className="detail__buy-label">商品</Text>
              <Text className="detail__buy-goods-title">{listing?.title ?? '—'}</Text>
              <Text className="detail__buy-goods-price">
                {`挂价 ¥${formatAmount(listing?.priceCents ?? 0)}`}
                {listing?.free ? ' · 免费送，金额固定为 0' : ''}
              </Text>
            </View>
            <View
              className={`detail__buy-field${(listing?.free ?? false) || buyBusy ? ' is-off' : ''}`}
            >
              <Text className="detail__buy-label">交易金额（元）</Text>
              <Input
                className="detail__buy-input"
                disabled={(listing?.free ?? false) || buyBusy}
                type="digit"
                value={buyAmount}
                onInput={(event) => {
                  setBuyAmount(event.detail.value)
                  setBuyAmountError(null)
                }}
              />
              {buyAmountError !== null ? (
                <Text className="detail__buy-err">{buyAmountError}</Text>
              ) : (
                <Text className="detail__buy-hint">
                  不填挂价也可以改：这就是和卖家商定的成交价，卖家接受时以此为准。
                </Text>
              )}
            </View>
            {buySubmitError !== null ? (
              <View className="detail__dlg-tip">
                <Text>{buySubmitError}</Text>
              </View>
            ) : null}
            <View className="detail__dlg-acts">
              <View className="detail__dlg-cancel" onClick={dismissBuy}>
                <Text>再想想</Text>
              </View>
              <View className={`detail__dlg-ok${buyBusy ? ' is-busy' : ''}`} onClick={confirmBuy}>
                {buyBusy ? <View className="detail__spin" /> : null}
                <Text>{buyBusy ? '正在发起…' : '发起交易确认'}</Text>
              </View>
            </View>
          </View>
        </>
      ) : null}

      {/* 回到顶部：抬到底部操作栏上方 */}
      <BackTop show={showTop} onTop={backToTop} bottom="240rpx" />
    </View>
  )
}
