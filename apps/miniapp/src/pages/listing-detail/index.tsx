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
import { Image, Input, Swiper, SwiperItem, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePageScroll, useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import ProductCard from '@/components/product-card'
import { loadListingDetail } from '@/features/fetchers'
import { fetchComments, postComment, postReply } from '@/features/listing/comments'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError, isUnauthenticatedError } from '@/lib/request'
import {
  categoryLabel,
  conditionLabel,
  formatAmount,
  type ListingDetailView,
  type MockComment,
  type MockListing,
} from '@/mock/api'
import { findUser } from '@/mock/users'
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
    id: `local-${localSeq}`,
    authorName: '我',
    authorInitial: '我',
    isSeller: false,
    content,
    timeLabel: '刚刚',
    replies: [],
  }
}

/** 相对时间文案（与 `features/fetchers.ts` 的 relativeLabel 同口径） */
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

/** 开发 / 预览回退用的 mock 留言 → 页面节点。 */
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
 * 独立端点（#111）：失败不能拖垮整页 —— 拿不到就退到 fixture（开发 / 预览）或空列表
 * （生产），商品详情本身照常渲染。
 */
async function loadComments(
  id: string,
  mockFallback: MockComment[],
): Promise<{ comments: CommentNode[]; nextCursor: string | null }> {
  try {
    const page = await fetchComments(id)
    return { comments: page.items.map(dtoToNode), nextCursor: page.nextCursor }
  } catch (error) {
    logCommentFailure('留言列表', error)
    // 开发 / 预览口径下 `loadListingDetail` 已经回退 fixture，这里跟着用同一批 mock 留言；
    // 生产口径拿不到就是空列表（不编数据）。
    return { comments: mockFallback.map(mockCommentToNode), nextCursor: null }
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

  const [data, setData] = useState<ListingDetailView | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [slide, setSlide] = useState(0)
  const [faved, setFaved] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  /** 留言树（顶层各带 replies）：初值来自加载结果，之后由本页的本地写操作增长 */
  const [comments, setComments] = useState<CommentNode[]>([])
  /** 留言列表的下一页游标；`null` = 没有更多（或还没加载完 / 退了 mock）。 */
  const [commentsCursor, setCommentsCursor] = useState<string | null>(null)
  /** 展开时拉取下一页的重入守卫（ref：state 更新是异步的，连点两次会都读到 false）。 */
  const loadingMoreRef = useRef(false)
  /** 组件是否还挂着；卸载后不再 setState（翻页是多次 await，中途离开页面很常见）。 */
  const mountedRef = useRef(true)
  useEffect(
    () => () => {
      mountedRef.current = false
    },
    [],
  )
  const [commentInput, setCommentInput] = useState('')
  /** 正在回复哪条顶层留言（`null` = 没有展开回复行）；稿子同时只开一行 */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyInput, setReplyInput] = useState('')

  const metrics = useMemo(() => readNavMetrics(), [])

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
    const solid = scrollTop >= navSolidThreshold
    if (solid === navSolidRef.current) return
    navSolidRef.current = solid
    setNavSolid(solid)
  })

  const load = () => {
    // 重试先清残留：上一轮的 notFound / failed 终态与旧数据不能带进新一轮加载（#121）
    setData(null)
    setLoadState('loading')
    // 三态分明：`ok` 渲染详情、`notFound` 走空态（商品真不存在）、
    // `failed` 走错误态 —— 生产口径不退回 mock，拿演示商品顶上比空态更误导
    void loadListingDetail(id).then(async (result) => {
      const view = result.status === 'ok' ? result.view : null
      setData(view)
      setLoadState(result.status === 'ok' ? 'ok' : result.status)
      // 详情一到就收骨架屏：留言是独立端点（#111），不能让它把商品本身的展示拖住。
      // 留言异步加载（不等详情的终态）：失败不拖垮整页，也不丢掉已拿到的商品信息。
      if (view) {
        const loaded = await loadComments(id, view.comments)
        setComments(loaded.comments)
        setCommentsCursor(loaded.nextCursor)
      } else {
        setComments([])
        setCommentsCursor(null)
      }
    })
  }

  useLoad(() => {
    load()
  })

  const [leftSimilar, rightSimilar] = useMemo(() => splitColumns(data?.similar ?? []), [data])

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

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
   * 发一条顶层留言：先乐观插入本页 state，再用服务端返回值替换掉本地占位。
   *
   * 失败口径（#111 后端已落地）：**明确失败必须回滚**并弹提示 ——
   * 尤其 422 审核拒绝不能让违规文本继续以正常留言样式留在页面上。
   */
  const sendComment = () => {
    const content = commentInput.trim()
    if (!content) return
    // 先算好再进 updater：updater 必须是纯函数，在里面自增 `localSeq` 会带副作用
    const pending = localComment(content)
    setComments((prev) => [pending, ...prev])
    setCommentInput('')
    void postComment(id, content)
      .then((created) => {
        // 用真实 DTO 换掉占位：拿到真实 id 后才能对它发起回复。
        setComments((prev) =>
          prev.map((node) => (node.id === pending.id ? dtoToNode(created) : node)),
        )
      })
      .catch((error) => {
        // 回滚本地占位 + 可见反馈；不回滚就会把失败说成成功。
        setComments((prev) => prev.filter((node) => node.id !== pending.id))
        notifyCommentFailure('留言', error)
      })
  }

  /** 回复某条顶层留言：同样先乐观插入，服务端确认后替换，失败回滚并提示 */
  const sendReply = (commentId: string) => {
    const content = replyInput.trim()
    if (!content) return
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
        setComments((prev) =>
          prev.map((node) =>
            node.id === commentId
              ? { ...node, replies: node.replies.filter((entry) => entry.id !== pending.id) }
              : node,
          ),
        )
        notifyCommentFailure('回复', error)
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
   * 展开时若还有下一页（`commentsCursor`），把剩余页全部拉完再展示：稿子写的是
   * 「查看全部 N 条」，只展示第一页却说「全部」就是在编计数。
   */
  const toggleComments = async () => {
    if (commentsOpen) {
      setCommentsOpen(false)
      return
    }
    setCommentsOpen(true)
    let cursor = commentsCursor
    // 用 ref 而非 state 做重入守卫：state 更新是异步的，连点两次时两次都会读到 `false`。
    if (!cursor || loadingMoreRef.current) return

    loadingMoreRef.current = true
    // 先在局部累积、成功后一次性 setComments：中途失败重试若逐页 append，
    // 会把上一次已追加的页再追加一遍（重复留言）。
    const more: CommentNode[] = []
    try {
      // 上游页码上限兜底：游标是服务端给的不透明串，服务端 bug 不能让这里转死循环。
      // 上限 20 页 × 单页 50 = 1000 条，远超设计稿需求。
      for (let pageCount = 0; cursor && pageCount < 20; pageCount += 1) {
        const page = await fetchComments(id, cursor)
        more.push(...page.items.map(dtoToNode))
        cursor = page.nextCursor
      }
      if (!mountedRef.current) return
      setComments((prev) => [...prev, ...more])
      setCommentsCursor(cursor)
    } catch (error) {
      // 未成功翻完就保持原游标（此时一条也没追加）；收起留言行，
      // 让下一次点击重新进“展开并继续拉取”，而不是先关一次再展开。
      logCommentFailure('更多留言', error)
      if (mountedRef.current) setCommentsOpen(false)
    } finally {
      loadingMoreRef.current = false
    }
  }

  const listing = data?.listing
  const images = listing?.images ?? []
  const visibleComments = commentsOpen ? comments : comments.slice(0, COMMENT_LIMIT)
  const paragraphs = listing ? descriptionLines(listing.description) : []

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
        <View className="detail__navrow">
          <View className="detail__back" onClick={handleBack}>
            <View className="detail__chevron" />
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
                  onChange={(event) => setSlide(event.detail.current)}
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
                  {/* 浏览量 / 想要数都不在契约里：真实数据下为 null，该指标整块不画，不显示 0 */}
                  {listing.views === null ? null : (
                    <Text className="detail__metric">
                      <Text className="detail__metric-num">{listing.views}</Text>
                      <Text> 浏览</Text>
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
                <View className="detail__go" onClick={() => toast('TA 的主页待接入')}>
                  <Text>进TA主页</Text>
                  <Image
                    className="detail__go-img"
                    src={ICONS.chevronRightMuted}
                    mode="aspectFit"
                  />
                </View>
              </View>
            </View>

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
                      卖家用**这张卡自己的** sellerId 查，不能用 `data.seller`。
                      `data.seller` 是**当前这件商品**的卖家；相似推荐是别人的商品，
                      把当前卖家挂上去就是给别人的商品捏造了一个卖家。
                      真实数据下 `item.sellerId` 是空串哨兵 → `findUser` 给 null → 整行不渲染；
                      mock 数据下每件相似商品本来就带自己的 sellerId，这里比原来更准确。
                    */
                    seller={findUser(item.sellerId)}
                    variant="home"
                    imageHeight={RATIO_HEIGHT[item.ratio]}
                  />
                ))}
              </View>
              <View className="detail__wf-col">
                {rightSimilar.map((item) => (
                  <ProductCard
                    key={item.id}
                    listing={item}
                    /* 同左列：用卡片自己的 sellerId，不用当前商品的卖家 */
                    seller={findUser(item.sellerId)}
                    variant="home"
                    imageHeight={RATIO_HEIGHT[item.ratio]}
                  />
                ))}
              </View>
            </View>
          </View>
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
      <View className="detail__bar">
        <View
          className={`detail__fav${faved ? ' is-on' : ''}`}
          onClick={() => setFaved((prev) => !prev)}
        >
          <Image
            className="detail__fav-img"
            src={faved ? ICONS.heartOn : ICONS.heartMuted}
            mode="aspectFit"
          />
        </View>
        <View className="detail__btn detail__btn--ghost" onClick={() => toast('聊天待接入')}>
          <Image className="detail__btn-img" src={ICONS.chatInk} mode="aspectFit" />
          <Text>聊一聊</Text>
        </View>
        <View className="detail__btn detail__btn--solid" onClick={() => toast('下单待接入')}>
          <Image className="detail__btn-img" src={ICONS.heartWhite} mode="aspectFit" />
          <Text>我想要</Text>
        </View>
      </View>
    </View>
  )
}
