import type { ListingCard, ListingDetail } from '@fish/contracts/listings/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchConversationPage, fetchMessagePage } from '@/features/chat/api'
import { toMockListing } from '@/features/listing/adapt'
import { fetchListingDetail, fetchMyListings, offlineListing } from '@/features/listing/api'
import { requestSellEdit, requestSellPrefill } from '@/features/listing/edit-target'
import { acceptTransaction, rejectProposal } from '@/features/transaction/api'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import { relativeTimeOf } from '@/lib/time'
import { formatAmount } from '@/mock/api'
import type { MockListing } from '@/mock/types'
import {
  cardLabel,
  countBySegment,
  emptyText,
  emptyTitle,
  lockNote,
  type MyListSegment,
  SEGMENTS,
  segmentLabel,
  segmentOf,
} from './list'
import { loadPendingIndex, type PendingIndex, type PendingProposal } from './pending'
import './index.scss'

/**
 * C4 我的发布（1版稿 `小程序1版mylist.html`，真实读写见 #89 mylist 行 / #74）。
 *
 * 数据源两路，合起来才是这一页：
 *
 * 1. `GET /listings?sellerId=自己` —— 本人视角的**全部状态**商品（只有本人视角才会把
 *    `status` 过滤打开，所以 OFFLINE / SOLD 也拿得到）。分段计数由本地按卡片算
 *    （服务端 feed 不返回分档计数）。
 * 2. 卖家自己的会话 —— 「谁在等我点头」这一半事实**只在会话里**（见下）。
 *
 * ## 顶栏（1版稿 ②③：两级顶栏一起钉在屏顶）
 *
 * 稿把「返回钮 + 居中标题」并进小程序导航条，第二级「状态分段」紧贴其下，两栏**都不参与
 * 滚动**，列表在它们下面滚；原稿那条「全部 7 件 · 在售 3 · …」统计行整段删掉（分段自己
 * 带计数，统计行只是把同一组数字再说一遍），27pt 大标题也随标题进栏一起删掉。
 *
 * 落地方式与同族的「收藏 / 历史 / 关注」三页**同一套**：`components/top-bar` 的 glass
 * 变体（`fixed` + 磨砂底 + 与原生胶囊的运行时避让 + 主行等高占位），分段控件进它的
 * `below` 槽与主行连成**同一块玻璃**。不用二级页那个漂浮的 `nav-bar` —— 它是
 * `position: absolute`、只有返回钮是实体，钉不住、也放不下副行。副行的占位由页面自补
 * （`.ml__header-gap`，组件不知道 `below` 多高）。
 *
 * 标题走**中槽 + 绝对定位到整栏中线**，而不是 `title` / `titleEm` 两个 prop（同
 * `pages/following`）：`components/top-bar` 的 `.topbar__row` 是普通 flex，`title` 渲染出来的
 * 标题**紧随返回钮左对齐**，而稿的 `.mp-title{left:50%;translate(-50%,-50%)}` 要求屏幕水平居中；
 * 中槽本身也不够（它只占「返回钮右侧 → 胶囊避让区左侧」那一段，在其中居中会偏左）。详见
 * JSX 处注释。
 *
 * ## 「待确认」段：稿的语义，但一半事实长在会话域
 *
 * 稿 ⑥ 把第二段从「已预订（成交前锁定）」改成**待确认**，并给出一张卡片该有的两样东西：
 * ① 谁在等（买家名字 + 等了多久）、② 能做什么（查看会话 / 拒绝 / 同意）。落地时这两样都
 * 有了着落，但**来源**与稿的演示数据不同：
 *
 * - 买家点「我想要」在后端不是商品状态，它只往会话写一条 `tx.proposal` SYSTEM 消息
 *   （`POST /transactions/proposals`），商品仍是 `ACTIVE`；只有**卖家接受**
 *   （`POST /transactions`，唯一创建交易行的端点）才会把商品置 `RESERVED`。
 *   所以「有买家在等」这件事必须从**卖家侧会话 + 会话内最后一个交易事件**推导，
 *   即 `./pending.ts` 的 `loadPendingIndex`。判据与 Web 端会话页同源
 *   （`apps/web/src/features/chat/chat-page.tsx` 的 `lastTxEvent`）。
 * - 因此本段装的是**两种**东西：`ACTIVE` + 未回应的提案（等卖家点头），以及 `RESERVED`
 *   （已同意、待面交）。后者是 `status` 本身就有的，卡片没有提案行。
 * - 「拒绝」= `POST /transactions/proposals/reject`（写 `tx.rejected`，商品留在在售）；
 *   「同意」= `POST /transactions`，金额取提案消息里的值（提案不落库，服务端无处可读）。
 *   同意之后这一件从「待确认」变成「已同意 · 等面交」，**交易码与面交流程长在订单页**，
 *   本页不重复实现 —— 所以本页给的是结果（`RESERVED`）与去处的提示，不做二维码那套。
 * - 「查看会话」对「待确认」是**精确**的一条（会话 id 来自提案所在的会话），对「已售出」
 *   落到消息 Tab 的会话列表 —— 商品读模型不带 `conversationId`，成交的会话 id 只
 *   存在于交易域（`TransactionDto.conversationId`），订单页拿得到、本页拿不到。
 *   这一条是**行为约束，不只是说明**：本页手里那条会话 id 是「最新一条卖家侧会话」，
 *   对已售出商品可能是另一个还在还价的买家，所以 `rows` 里只为「待确认」段带上它
 *   （见该处注释）。**不要**图省事给已售出也塞一个 id —— 那是把错的会话当成交记录。
 * - 「待确认」与「已售出」两段**不渲染编辑按钮**（稿 ⑥：等卖家点头前不可编辑；成交记录锁定）。
 *   「待确认」的「先别改」由卡片上那行「谁在等」与旁边的决策按钮表达，所以**不挂锁图标**
 *   （稿 ⑥ 也写了「待确认的『先别改』由买家那一行 + 决策按钮表达，不再挂锁图标」）。
 *
 * ## 与稿的**偏离**（不是漏做，是今天做不到 / 不做）
 *
 * 1. **「同意」不跳订单页**：稿里那一跳是演示外壳（订单页当时也只认 `view`）。真实链路上
 *    同意之后先要知道这笔交易确实建成了，本页重拉列表即可看到它进「待确认 · 等面交」；
 *    订单页就在「我的 → 我卖出的」里，不替用户跳过去。
 *
 * 稿里那句「重新上架 / 再次上架 · 浏览与想要数保留」兑现不了：既因为两个量都不存在
 * （见下），也因为这两个按钮**都是新建一条**（Owner 2026-09-24 拍板），原条会留在原处。
 * 相关 toast 与弹层提示因此改成了能兑现的说法。
 *
 * **卡片上的「浏览 / 想要」计数按 Owner 2026-09-24 的拍板显示 0**（不是隐藏）：
 * 契约 `ListingCardSchema` 与 `listings` 表都没有这两个量（Issue #192），
 * `adapt.ts` 的投影给 `null`，渲染层 `?? 0`。**这个 0 只表示「系统没有这个数」**，
 * 不表示「没人看过 / 没人想要」—— 真实的采集与口径归 #192。
 *
 * **「再次上架」（已售出）与「重新上架」（已下架）都走「出物页新建 + 预填」**
 * （Owner 2026-09-24 拍板：这两个按钮就是「直接通往出物页，帮他填上信息」）。
 * 把原商品的文案字段（标题 / 描述 / 价格 / 分类 / 成色 / 急出 / 议价 / 0 元送）带过去，
 * 用户确认后提交才产生**新的一条**；**图片必须重选**（详情响应刻意不给 `objectKey`，
 * 存储布局不进读协议），出物页会明说这一点。
 * 代价：`POST /listings/:id/online` 在这条路径上不再被调用，原条会留在「已售出」/「已下架」里，
 * 用户要自己决定怎么处理它 —— 这是拍板接受的取舍，不是漏做。
 *
 * ## 其余保留的口径
 *
 * - **审核态不参与这一页**（Owner 2026-09-24 拍板：**商品全流程里没有「审核中」这个前端状态**）。
 *   Owner 口述的全流程：发布 → **AI 审核（瞬时，没有进行状态，直接出结果）** → 在售 →
 *   买家点「我想要」→ 待确认 → 双方同意 → 待面交 → 线下面交（交易码）→ 已完成 →
 *   点「重新上架」回出物页重新发布（让一件商品可以反复卖 / 批发卖）。
 *   所以卡片的分段只由 `status` 决定，`moderationStatus` 一律不读 —— 卡在审核里的商品在
 *   库里同样是 `status = OFFLINE`，与「自己下架的」一起读作「已下架」；前端不给出审核中
 *   状态，就不存在「把审核中的商品拿去重新上架」这条路径（见 `relist` 处说明）。
 * - **编辑入口只给在售 / 已下架**：`RESERVED` / `SOLD` 被交易锁定（与服务端
 *   `LOCKED_LISTING_STATUSES` 同一口径，违者 409），「待确认」按稿 ⑥ 也不给。
 * - **下架要二次确认**（稿 ⑤ 的真状态机）：遮罩 + 居中确认卡，确认按钮有「默认可点 /
 *   下架中 / 失败重试」三态；成功与失败都以服务端响应为准，不本地假装成功。
 * - **「同意」以服务端结论为准**：商品置 `RESERVED` 是接受那一步的服务端行为，本地不假改；
 *   契约冻结的重试口径说 409 `LISTING_NOT_ACTIVE` 表示「商品已不是 ACTIVE」（并发买家赢了，
 *   或上一次其实已经成功），所以 409 一律**重拉列表**而不是直译成「同意失败」。
 * - **编辑入口**：出物是 Tab 页，不能带 query 跳转 —— 走 `features/listing/edit-target.ts`
 *   的一次性交接 + `switchTab`。
 * - **下拉刷新用微信原生**（`index.config.ts` + `usePullDownRefresh`，先例 `pages/orders-buy`）：
 *   稿里那套 pointer 事件的假 refresher 是小程序外的演示外壳，不实现。
 *
 * **账号作用域（correctness）**：`cards` / `confirming` / `segment` / `loading` / 待确认索引
 * 全都属于「当前登录用户」。换账号时必须在**渲染期同步**清空，并用加载代次丢弃迟到响应 ——
 * 否则会出现「B 的身份已经渲染、画的却是 A 的商品」，甚至拿着 A 的 listing id 去发下架请求。
 * 详见 `prevUserId` / `loadEpoch` 处的注释。
 */
type SubmitState = 'idle' | 'busy' | 'failed'

/** 一行的渲染视图：契约卡片投影成页面既有的 `MockListing`（`adapt.ts` 负责「不编造字段」） */
type Row = {
  listing: MockListing
  segment: MyListSegment
  statusLabel: string
  /** 这一行对应的会话；**只有「待确认」段带值**（已售出拿不到成交那条，见 `rows` 处注释） */
  conversationId: string
  /** 待确认段在等的那条提案；已同意（`RESERVED`）与其它段为 null */
  proposal: PendingProposal | null
}

/** 状态胶囊配色（在售浅蓝 / 待确认 warn / 已售出灰 / 已下架描边） */
const PILL_CLASS: Record<MyListSegment, string> = {
  sale: 'is-sale',
  pending: 'is-pending',
  sold: 'is-sold',
  off: 'is-off',
}

/**
 * 操作区贴右收口的段（1版稿 ⑪）：在售（编辑 / 下架）与已下架（编辑 / 重新上架）都只有
 * 两个按钮，左起排会在那一行里空掉右半条，看着跟上面的缩略图 / 文案脱开。
 *
 * 待确认（三按钮，行首是「查看会话」）与已售出（锁定说明 + 两按钮）仍左起排：稿 ⑪ 的口径是
 * 「它们行首要么是主操作、要么是说明文字，左起才是阅读顺序」。
 */
const END_ALIGNED: MyListSegment[] = ['sale', 'off']

/**
 * 回到顶部钮的出现阈值。
 *
 * 本页的 1版稿 `.totop` 是在**内部滚动容器**上按 `scrollTop > 320` 判的（`.content{overflow-y:auto}`），
 * 本页是页面级滚动，`usePageScroll` 给的 `scrollTop` 是**设备 px**（≈ 稿的 pt），两者不是同一把尺子；
 * 且仓库对「页面级滚动列表」已有同口径先例（`pages/chat` / `pages/profile` / `components/order-list`
 * 都是 380），所以这里跟先例走，不照抄稿的 320 —— 阈值只决定按钮早露头还是晚露头，观感差约一成。
 */
const TOTOP_THRESHOLD = 380

export default function MyList() {
  const authStatus = useAuthGuard()
  const auth = useAuth()
  const userId = auth.user?.id ?? null
  /**
   * 顶栏栅格（状态栏高 / 内容行高）。**必须来自 `lib/nav-metrics` 的运行时反推**，
   * 不能照抄稿里的固定值：稿的胶囊是画出来的假胶囊，真机上那个位置由微信原生绘制，
   * 每台机器都不同。这些值只用于行内 style（见 JSX）。
   */
  const metrics = useMemo(() => readNavMetrics(), [])

  const [cards, setCards] = useState<ListingCard[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  /**
   * 手里这份 `cards` 是不是**全部**（翻页翻到了底）。
   *
   * `fetchMyListings` 封顶 5 页（250 件），到顶还有下一页时它是 false。这个标记只影响
   * 两处对「这份列表」下的结论：分段计数与「已经到底了 · N 件」。列表不完整时它们就是错的
   * —— 与 `components/order-list` 的 `truncated` 同一口径。
   */
  const [truncated, setTruncated] = useState(false)
  /** 待确认索引（从卖家侧会话推导，见 `./pending.ts`）。`complete` / `failed` 都参与收口 */
  const [pending, setPending] = useState<PendingIndex>(() => ({
    proposals: new Map(),
    conversationIds: new Map(),
    complete: true,
    failed: false,
  }))
  /** 待确认索引正在读：这期间**不知道**谁在等，所以分段计数与逐段结论都要收着（见 showCounts） */
  const [pendingLoading, setPendingLoading] = useState(true)
  /** 正在处理的提案所在会话 id（拒绝 / 同意期间两个按钮都禁用，避免重复提交） */
  const [pendingBusy, setPendingBusy] = useState<string | null>(null)
  /**
   * 正在「再次上架」的那件商品 id：这一下要先取详情再跳出物页，取的过程中按钮置灰，
   * 避免连点两次往交接位里塞两份草稿（后一份会覆盖前一份，用户看到的是哪一件就说不准了）。
   */
  const [relistBusy, setRelistBusy] = useState<string | null>(null)
  const [segment, setSegment] = useState<MyListSegment>('sale')
  const [showTop, setShowTop] = useState(false)
  /** 下架确认弹层：null = 关闭；否则是被操作的那一行 */
  const [confirming, setConfirming] = useState<Row | null>(null)
  const [submit, setSubmit] = useState<SubmitState>('idle')
  /**
   * 每次显示本页 +1，驱动重新拉取。
   *
   * 初值是 `null`（还没显示过）而不是 0：`useDidShow` 会在首次显示时置 1，
   * 这样「已登录时进入本页」只会请求一次，而不是 effect 与 didShow 各拉一遍。
   */
  const [showToken, setShowToken] = useState<number | null>(null)
  /**
   * 本页数据**属于哪个账号**。
   *
   * 渲染期就能拿到上一帧的 `userId`，所以在**同一帧内**把账号作用域状态清干净，
   * 不会出现「B 的身份已经渲染出来了，画的却还是 A 的商品」那一帧。
   * 换成 `useEffect(() => setCards([]), [userId])` 不行：effect 在 commit 之后才跑，
   * 泄漏帧照样存在。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  /** 加载代次：切换账号、重新拉取都会 +1，用来丢弃迟到响应（见下） */
  const loadEpoch = useRef(0)
  /**
   * 下拉刷新的一次性标记（原生指示器已经拉出来了，见 `usePullDownRefresh`）：
   *
   * - `keepList`：本次加载**不要**把列表换回骨架屏 —— 用户已经读过一段，换成骨架屏等于
   *   把阅读位置弄丢（与 `pages/orders-buy` 的 `keepList` 同一取舍）；
   * - `stopPull`：本次加载结束后收掉原生指示器。收尾照旧放在 effect 的 `finally` 里 ——
   *   那才是「这一次请求真的结束了」（成功与失败都算）的唯一位置。
   */
  const keepList = useRef(false)
  const stopPull = useRef(false)
  /**
   * 屏幕上这份卡片集合的指纹（id 顺序拼接）。用来判断「新拉到的列表与手上这份是否同一批」：
   * 下拉刷新时若商品没变，旧索引仍然配得上，计数不必收；变了才要收（见加载 effect）。
   */
  const cardSetRef = useRef('')

  if (prevUserId !== userId) {
    setPrevUserId(userId)
    // 旧账号所有在飞的请求立即作废
    loadEpoch.current += 1
    // 账号作用域的界面状态一律重置：卡片、完整度、待确认索引、加载态、分段、下架确认弹层
    setCards([])
    cardSetRef.current = ''
    setTruncated(false)
    setPending({ proposals: new Map(), conversationIds: new Map(), complete: true, failed: false })
    setPendingLoading(true)
    setPendingBusy(null)
    setLoading(true)
    setFailed(false)
    setSegment('sale')
    setConfirming(null)
    setSubmit('idle')
    /*
     * 换账号时若有下拉刷新正卡在收尾等待上，它那一次的 `finally` 会被代次守卫拦下
     * （`epoch === loadEpoch.current` 已不成立），原生指示器就再没人收。
     * 这里补一刀，别让圈一直转着。
     */
    if (stopPull.current) {
      stopPull.current = false
      void Taro.stopPullDownRefresh()
    }
  }

  useDidShow(() => {
    setShowToken((token) => (token ?? 0) + 1)
  })

  /**
   * 待确认索引的读取（会话列表 → 逐会话消息页）。
   *
   * 它**不阻塞**商品列表：两路各拉各的，谁先到先画。`epoch` 由调用方给，
   * 迟到响应一律丢弃（与商品列表同一把尺子，避免换账号后旧索引落到新账号的列表上）。
   *
   * 用 `useCallback` 固定引用，好让下面的加载 effect 把它列进依赖而不反复触发。
   */
  const loadPending = useCallback(async (listingIds: string[], epoch: number) => {
    const index = await loadPendingIndex(
      new Set(listingIds),
      (cursor) => fetchConversationPage(cursor),
      (conversationId) => fetchMessagePage(conversationId),
    )
    if (epoch !== loadEpoch.current) return
    setPending(index)
    setPendingLoading(false)
  }, [])

  useEffect(() => {
    if (showToken === null || authStatus !== 'authed' || userId === null) return

    // 本次请求的代次：返回时若已不是最新一次，整批结果（含失败态）全部丢弃
    const epoch = ++loadEpoch.current
    // 读完立刻复位：这是「本次加载」的标记，读到就必须清掉
    const keep = keepList.current
    keepList.current = false

    setLoading(!keep)
    setFailed(false)

    void (async () => {
      try {
        const next = await fetchMyListings(userId)
        if (epoch !== loadEpoch.current) return
        /*
         * 商品列表一换（重进本页 / 换账号），待确认索引必须跟着重算：它是按商品 id 取的交集，
         * 拿着旧卡片算出来的索引会缺项（新发布的商品永远进不了「待确认」）。
         *
         * **下拉刷新且商品没变时不置「加载中」**：`keepList` 的意义就是「让用户手上的这一屏
         * 继续成立」，而 `pendingLoading` 一旦为真，`showCounts` 立刻把整排分段计数收掉、
         * 底部还多挂一句「正在读取待确认…」—— 用户只是想刷新一下，却眼看四个数字消失。
         * 商品一模一样时旧索引仍然配得上（同一次成功加载的产物），照旧显示即可。
         *
         * ⚠️ **商品变了就必须收**：`setCards` 是同步生效的，而索引要等下面 `loadPending`
         * 那一串请求回来才更新。中间这段时间是「新卡片 + 旧索引」—— 恰好是这个判据要防的
         * 「计数是猜的」（刚发布、已经有人点了我想要的商品会被算进在售）。
         */
        const fingerprint = next.items.map((card) => card.id).join(',')
        setCards(next.items)
        setTruncated(next.truncated)
        if (fingerprint !== cardSetRef.current) {
          cardSetRef.current = fingerprint
          setPendingLoading(true)
        }
        // 商品列表到手才开始推待确认：要拿它筛会话（别人商品的会话与本页无关）
        void loadPending(
          next.items.map((card) => card.id),
          epoch,
        )
      } catch {
        if (epoch !== loadEpoch.current) return
        /*
         * 失败时**不动** `cards` / `truncated`：失败一律给空结果，直接写进去就等于
         * 「把用户已经读到的商品清空」—— 下拉刷新失败时尤其糟（阅读位置白丢）。
         * 换账号的清空由上面渲染期重置负责，迟到响应的作废由代次负责，都不靠这里。
         * 与 `features/transaction/useOrderList` 同一取舍。
         */
        setFailed(true)
        /*
         * 待确认索引同理：**下拉刷新失败时不动它**。旧卡片配旧索引是自洽的（同一次成功
         * 加载的产物），屏幕上那份列表也还在；这时候把它标成 failed，只会让「在售 / 待确认」
         * 的分段计数跟着消失 —— 而用户本来只是想刷新一下。
         * 只有首屏（或换账号后）真的一件都没读到，才把这一路标成「没读到」。
         */
        if (!keep) {
          setPendingLoading(false)
          setPending({
            proposals: new Map(),
            conversationIds: new Map(),
            complete: false,
            failed: true,
          })
        }
      } finally {
        // 不能写成 `if (…) return`：`noUnsafeFinally`（finally 里的 return 会吞异常）
        if (epoch === loadEpoch.current) {
          setLoading(false)
          if (stopPull.current) {
            stopPull.current = false
            void Taro.stopPullDownRefresh()
          }
        }
      }
    })()
  }, [showToken, authStatus, userId, loadPending])

  /**
   * 原生下拉刷新：只重新拉一遍（`keepList`，见 ref 注释）。刷新完**不弹提示** ——
   * 有没有新数据看列表本身，弹一句「已刷新」是在声称一件看不见的事。
   */
  usePullDownRefresh(() => {
    if (authStatus !== 'authed' || userId === null) {
      void Taro.stopPullDownRefresh()
      return
    }
    keepList.current = true
    stopPull.current = true
    setShowToken((token) => (token ?? 0) + 1)
  })

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > TOTOP_THRESHOLD))

  const awaitingIds = useMemo(() => new Set(pending.proposals.keys()), [pending])
  const counts = countBySegment(cards, awaitingIds)
  /**
   * 首屏（还没有任何卡片）的加载中：稿 ④ 帧的骨架态不给分段计数。
   * 刷新失败但列表还在时照常给数字 —— 它们描述的正是屏幕上这份列表。
   */
  const firstLoading = loading && cards.length === 0
  /**
   * 计数只在「这份列表确实是全部」时才有意义：
   *
   * - 首屏骨架态不给数字（稿 ④ 帧同口径）；
   * - 翻页到上限（`truncated`）时每段都会少算，显示出来就是把不完整的数据当结论；
   * - **待确认索引还没读到 / 只读到一部分**（`pendingLoading` / `!pending.complete` /
   *   `pending.failed`）时，「在售」与「待确认」两段的边界本身就是猜的 —— 一件有买家在等的
   *   商品会被计进在售。这两段恰好是本页最要命的两个数字，所以整排计数一起收起来；
   * - 一条都没加载出来（首次加载 / 重试失败）时全是 0，那是**假零** —— 用户以为自己没有商品。
   *
   * 前三个判据与 `components/order-list` 的 `showCounts` 同源，第四条是本页特有的。
   */
  const countsReliable = pending.complete && !pending.failed && !pendingLoading
  const showCounts =
    !firstLoading && !truncated && countsReliable && !(failed && cards.length === 0)

  const rows: Row[] = cards.map((card) => {
    /*
     * `awaiting` **只对 `ACTIVE` 成立**：买家提案只检查商品是 `ACTIVE`
     * （`transactions/service.ts` 的 `propose`），所以两个买家能同时对同一件商品提案。
     * 卖家同意其中一个之后商品变 `RESERVED`，**输的那个买家的 `tx.proposal` 还留在会话里**
     * —— 它仍是那条会话的最后一个交易事件。
     *
     * 若不加这个条件，那件已同意的商品会被读成「还有人在等」：胶囊翻回「待确认」、
     * 卡片上摆着输家的名字与 同意 / 拒绝 两个按下去必然 409（商品已非 `ACTIVE`）的按钮，
     * 而真正的事实「已同意 · 等面交」被顶掉。
     */
    const awaiting = card.status === 'ACTIVE' && awaitingIds.has(card.id)
    const key = segmentOf(card, awaiting)
    // 只有「待确认」段可能带提案：`RESERVED`（已同意）有会话但没有在等的提案
    const proposal = key === 'pending' ? (pending.proposals.get(card.id) ?? null) : null
    return {
      listing: toMockListing(card),
      segment: key,
      statusLabel: cardLabel(key, awaiting),
      /*
       * 会话 id **只给「待确认」段**（见下）：
       *
       * - 有提案 → 提案所在的那条会话（精确，就是卖家要点头的那条）；
       * - 没提案（`RESERVED`，已同意待面交）→ 退到「这件商品最新的一条卖家侧会话」，
       *   它是手里最接近成交那条的候选；
       * - **已售出不给**：成交的会话 id 只存在于交易域（`TransactionDto.conversationId`，
       *   订单页拿得到、本页拿不到）。`conversationIds` 给的是「最新一条卖家侧会话」，
       *   对一件已成交商品来说那可能是**另一个还在还价的买家** —— 跳过去就是把错的会话
       *   当成成交记录摆给卖家看。所以这一段的「查看会话」落到消息 Tab 的会话列表。
       */
      conversationId:
        key === 'pending'
          ? (proposal?.conversationId ?? pending.conversationIds.get(card.id) ?? '')
          : '',
      proposal,
    }
  })
  const shown = rows.filter((row) => row.segment === segment)

  /**
   * 本屏的「现在」取一次，逐行复用。
   *
   * `lib/time.ts` 的约定（`relativeTimeOf` / `dayLabelOf` 的 `nowMs` 参数）：
   * 每行各取一次 `Date.now()` 会算出互相矛盾的相对时间 —— 同一屏里一张卡写「2 小时前」、
   * 下一张因为多跑了几毫秒而写「3 小时前」。`pages/chat` 的会话列表同一做法。
   */
  const now = Date.now()

  const toast = (text: string) => {
    void Taro.showToast({ title: text, icon: 'none' })
  }

  const reload = () => {
    setShowToken((token) => (token ?? 0) + 1)
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /** 切分段：关掉可能开着的确认弹层，避免弹层停在错的商品上；并回到列表顶部 */
  const pickSegment = (key: MyListSegment) => {
    setSegment(key)
    setConfirming(null)
    setSubmit('idle')
    // 换段等于换了一份列表，停在上一段的滚动位置会落在列表中间
    backToTop()
  }

  const openListing = (row: Row) => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${row.listing.id}` })
  }

  /**
   * 编辑：把 id 交给出物页并切到那个 Tab —— Tab 页不能带 query（见 `edit-target` 说明）。
   *
   * **只给「在售」/「已下架」两段用**（调用处就是那个渲染条件）：
   * 「待确认」按稿 ⑥ 不给编辑入口（等卖家点头前先别改，那一段的说明由卡片上的
   * 「谁在等」一行与决策按钮承担），「已售出」的成交记录锁定、压根不渲染这个按钮 ——
   * 所以这里不必再分支，那两段不会走到这儿。
   */
  const edit = (row: Row) => {
    requestSellEdit(row.listing.id)
    void Taro.switchTab({ url: '/pages/sell/index' })
  }

  /**
   * 「再次上架」（已售出）/「重新上架」（已下架）：**都跳出物页新建一条**，把原商品的
   * 文案字段带过去。
   *
   * Owner 2026-09-24 拍板：这两个按钮都是「直接通往出物页，帮他填上信息」，
   * 不在本页直接调 `POST /listings/:id/online`。所以两条路径合成这一个函数，
   * 差别只剩按钮文案。**「重新上架」的意义是让一件商品不只是卖一次，可以批发的卖**
   * （Owner 口述的商品全流程：… 已完成 → 点「重新上架」回出物页重新发布）。
   *
   * 于是原来那条「重新上架 = 同一条回来、浏览 / 想要数保留」的口径不再成立：
   * 新建出来的是另一条，原条留在「已下架」里，用户要自己决定怎么处理它。
   *
   * 字段取自**详情**而不是列表卡：列表卡的投影（`toMockListing`）里没有 `description`
   * （商品读模型不带描述，`adapt.ts` 显式留空），拿它预填就等于把描述悄悄丢掉。
   * 这多出来的一次请求换来的是「预填的内容就是原商品的内容」，值。
   * 图片必须重选（详情不给 `objectKey`）。
   */
  const relist = (row: Row) => {
    if (relistBusy) return
    setRelistBusy(row.listing.id)
    void (async () => {
      try {
        const detail = await fetchListingDetail(row.listing.id)
        if (!detail) {
          toast('这件商品已经找不到了')
          return
        }
        requestSellPrefill({
          title: detail.title,
          description: detail.description,
          priceCents: detail.priceCents,
          category: detail.category,
          condition: detail.condition,
          urgent: detail.urgent,
          negotiable: detail.negotiable,
          free: detail.free,
        })
        void Taro.switchTab({ url: '/pages/sell/index' })
      } catch (error) {
        toast(errorText(error, '打开失败，请重试'))
      } finally {
        setRelistBusy(null)
      }
    })()
  }

  /**
   * 上下架成功后只改这两个字段：其余字段服务器没动，本地不重造整张卡。
   * `moderationStatus` 本页不再参与渲染（见页头「审核态不参与这一页」），这里一并同步是为了
   * 让本地卡片与服务端真值保持一致，不给以后读它的人留下陈旧值。
   */
  const applyTransition = (detail: ListingDetail) => {
    setCards((prev) =>
      prev.map((card) =>
        card.id === detail.id
          ? { ...card, status: detail.status, moderationStatus: detail.moderationStatus }
          : card,
      ),
    )
  }

  const errorText = (error: unknown, fallback: string): string =>
    isApiError(error) ? error.message || fallback : fallback

  const confirmOffline = () => {
    if (!confirming || submit === 'busy') return
    const target = confirming
    setSubmit('busy')
    void (async () => {
      try {
        const detail = await offlineListing(target.listing.id)
        applyTransition(detail)
        setSubmit('idle')
        setConfirming(null)
        setSegment('off')
        toast('已下架')
      } catch (error) {
        // 失败就停在弹层里给「重试」，不关弹层、也不本地改状态
        setSubmit('failed')
        toast(errorText(error, '下架失败，请重试'))
      }
    })()
  }

  /** 「查看会话」：有会话 id 就精确跳那一条，否则退回消息 Tab 的会话列表 */
  const openConversation = (row: Row) => {
    if (row.conversationId) {
      void Taro.navigateTo({ url: `/pages/conversation/index?id=${row.conversationId}` })
      return
    }
    void Taro.switchTab({ url: '/pages/chat/index' })
  }

  /**
   * 拒绝提案：`POST /transactions/proposals/reject` 只写一条 `tx.rejected` SYSTEM 消息，
   * **商品仍在售**（提案阶段商品一直是 `ACTIVE`）。所以本地不假改状态，重拉列表为准。
   */
  const declineProposal = (row: Row) => {
    const proposal = row.proposal
    if (!proposal || pendingBusy !== null) return
    setPendingBusy(proposal.conversationId)
    void (async () => {
      try {
        await rejectProposal(proposal.conversationId)
        toast('已拒绝 · 商品留在在售')
        reload()
      } catch (error) {
        toast(errorText(error, '拒绝失败，请重试'))
      } finally {
        setPendingBusy(null)
      }
    })()
  }

  /**
   * 同意提案：`POST /transactions` 建交易行并把商品置 `RESERVED`，商品随之进「待面交」。
   *
   * 面交流程（取交易码 / 出示 / 核验）长在订单页，本页不重复实现，也**不替用户跳过去** ——
   * 同意之后先要确认这笔交易确实建成了，本页重拉列表即可看到它变成「已同意 · 等面交」。
   *
   * **409 `LISTING_NOT_ACTIVE` 不当作失败**：契约冻结的重试口径说它表示「商品已不是 ACTIVE」
   * （并发买家赢了，或上一次其实已经成功），所以重拉列表让用户看到真实状态，而不是弹一句
   * 「同意失败」把人推去重复点击。
   */
  const acceptProposal = (row: Row) => {
    const proposal = row.proposal
    if (!proposal || pendingBusy !== null) return
    setPendingBusy(proposal.conversationId)
    void (async () => {
      try {
        await acceptTransaction(proposal.conversationId, proposal.amountCents)
        toast('已同意 · 在「我卖出的」里约面交')
        reload()
      } catch (error) {
        if (isApiError(error) && error.status === 409) {
          toast('这件商品已经不在了 · 已刷新')
          reload()
        } else {
          toast(errorText(error, '同意失败，请重试'))
        }
      } finally {
        setPendingBusy(null)
      }
    })()
  }

  const goPublish = () => {
    void Taro.switchTab({ url: '/pages/sell/index' })
  }

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   * 本页写操作必须带会话，不拦的话跳转落地前会先画一帧别人的数据。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />
  return (
    <View className="ml">
      <View className="ml__bg" />

      {/*
        两级顶栏合一（1版稿 ②③）：一级栏 = 返回 + 居中标题（「发布」走品牌色）+ 微信胶囊，
        二级栏 = 状态分段控件；两栏一起钉在屏顶、都不参与滚动。

        分段进 `below` 槽而不是另起一块 sticky：它与主行共用同一块玻璃、描边落在整块底边，
        与消息页的筛选行 / 收藏页的分段胶囊是同一个形态。右侧避让（原生胶囊）由组件按
        运行时读到的胶囊位置下发，页面不管。
      */}
      <TopBar
        variant="glass"
        spacer
        back
        center={
          /*
            标题走**中槽 + 绝对定位到整栏中线**，而不是 `title` / `titleEm` 两个 prop
            （与 `pages/following` 同一做法）：

            - 那两个 prop 渲染出的标题是**紧随返回钮左对齐**的（`.topbar__row` 是普通 flex），
              而稿 `.mp-title{position:absolute;left:50%;top:50%;translate(-50%,-50%)}` 要求
              **屏幕水平居中**；
            - 中槽本身也不够：`.topbar__center` 是 `flex: 1 1 auto`，可用区间是「返回钮右侧 →
              胶囊避让区左侧」，在其中居中会落在偏左的位置。

            所以这里把它绝对定位到整条栏的中线（`.topbar` 是 `position: fixed`，天然是绝对
            定位后代的包含块），`top` / `height` 由组件同一套运行时栅格给出：`top` = 状态栏高、
            `height` = 内容行高，于是标题在**胶囊那一行**垂直居中（与返回钮同一水平中线），
            不会跟着整条栏变高一起下偏。

            这两个是设备 px，必须走行内（pxtransform 只处理样式表；内联 px 原样下发）——
            与 `lib/nav-metrics` 的口径一致。
          */
          <View
            className="ml__navtitle"
            style={{
              top: `${metrics.statusBarHeight}px`,
              height: `${metrics.contentHeight}px`,
            }}
          >
            <Text>我的</Text>
            {/* 稿 `.mp-title .hl{color:var(--brand)}`：尾段走品牌色 */}
            <Text className="ml__navtitle-em">发布</Text>
          </View>
        }
        below={
          <View className="ml__segwrap">
            <View className="ml__seg">
              {SEGMENTS.map((seg) => (
                <View
                  key={seg.key}
                  // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child）
                  className={`ml__seg-item ml__seg-item--${seg.key}${
                    seg.key === segment ? ' is-on' : ''
                  }`}
                  onClick={() => pickSegment(seg.key)}
                >
                  <Text>{seg.label}</Text>
                  {/* 计数由本地卡片算；首屏骨架态、列表不完整、待确认没读到时都不给数字（见 showCounts） */}
                  {showCounts ? <Text className="ml__seg-n num">{counts[seg.key]}</Text> : null}
                </View>
              ))}
            </View>
          </View>
        }
      />
      {/* 副行占位：组件的 `spacer` 只含主行，分段这一截要页面自己补（见 index.scss） */}
      <View className="ml__header-gap" />

      <View className="ml__body">
        {firstLoading ? (
          <>
            {[0, 1, 2].map((i) => (
              <View key={`sk-${i}`} className="ml__skel">
                <View className="ml__skel-row">
                  <View className="ml__skel-sq" />
                  <View className="ml__skel-col">
                    <View className="ml__skel-bar" style={{ width: '82%' }} />
                    <View className="ml__skel-bar ml__skel-bar--price" style={{ width: '34%' }} />
                    <View className="ml__skel-bar ml__skel-bar--meta" style={{ width: '52%' }} />
                  </View>
                </View>
                {/* 按钮行贴右：骨架态先摆出真卡片在售 / 已下架的收口（稿 `.skel-foot` / ⑪） */}
                <View className="ml__skel-foot">
                  <View className="ml__skel-btn" />
                  <View className="ml__skel-btn ml__skel-btn--sm" />
                </View>
              </View>
            ))}
            <View className="ml__skel-hint">
              <View className="ml__skel-spin" />
              <Text>正在读取发布记录…</Text>
            </View>
          </>
        ) : (
          <>
            {/*
              接口失败：一条都没有时用它顶替列表（这时它是「没加载出来」，不是「恰好没有」）；
              手里还有上一次成功的结果时放在列表上方当一条提示 —— 已经读到的列表不该因为
              一次刷新失败整片消失（下拉刷新失败尤其糟），与 `components/order-list` 同一取舍。
            */}
            {failed ? (
              <LoadError
                onRetry={reload}
                text={cards.length > 0 ? '以下为上次加载的发布记录' : '我的发布加载失败,请重试'}
              />
            ) : null}

            {/*
              两件「这份列表不是全部」的实话，各自一行：
              - 商品翻页到上限（`truncated`）：段计数与「已经到底了」都不成立；
              - 待确认索引没读到 / 只读到一部分（`pendingLoading` / `!complete` / `failed`）：
                「在售」与「待确认」的边界是猜的。这一行必须说出来 —— 否则用户会以为
                一件有买家在等的商品就是在售。
            */}
            {!loading && truncated ? (
              <Text className="ml__partial num">{`发布较多 · 仅显示最近 ${cards.length} 件`}</Text>
            ) : null}
            {!firstLoading && (pendingLoading || !countsReliable) ? (
              <Text className="ml__partial num">
                {pending.failed
                  ? '待确认读取失败 · 下拉可重试'
                  : pendingLoading
                    ? '正在读取待确认…'
                    : '待确认可能不全 · 仅显示读到的部分'}
              </Text>
            ) : null}

            {!failed && shown.length === 0 ? (
              <View className="ml__empty">
                <View className="ml__empty-disc">
                  <Image className="ml__empty-ic" src={ICONS.box} mode="aspectFit" />
                </View>
                {/*
                  列表不完整时不能说「这个状态下还没有东西」—— 那是拿一份已知不完整的数据
                  下结论。这时只说手里这份里没有（与 `components/order-list` 的空态同一口径）。
                */}
                <Text className="ml__empty-title">
                  {truncated ? '已加载的发布里没有这一状态' : emptyTitle(segment)}
                </Text>
                <Text className="ml__empty-text">{emptyText(segment)}</Text>
                {/*
                  稿的口径：只有「已下架」这一段的出路是回在售看，其余各段都是「去发布一件」
                  （在售空着时再让人回在售看，是把他推进另一个空态）。
                */}
                <View
                  className="ml__empty-act"
                  onClick={() => (segment === 'off' ? pickSegment('sale') : goPublish())}
                >
                  <Text>{segment === 'off' ? '回「在售」看看' : '去发布一件'}</Text>
                </View>
              </View>
            ) : null}

            {shown.length > 0 ? (
              <>
                <View className="ml__list">
                  {shown.map((item) => (
                    <View key={item.listing.id} className="ml__item">
                      <View className="ml__row">
                        <View className="ml__thumb" onClick={() => openListing(item)}>
                          <Image
                            className="ml__thumb-img"
                            src={item.listing.coverUrl}
                            mode="aspectFill"
                          />
                        </View>

                        <View className="ml__main">
                          <View className="ml__rtop">
                            <Text className="ml__rtitle" onClick={() => openListing(item)}>
                              {item.listing.title}
                            </Text>
                            <Text className={`ml__pill ${PILL_CLASS[item.segment]}`}>
                              {item.statusLabel}
                            </Text>
                          </View>

                          <View className="ml__price">
                            <Text className="ml__price-amt num">
                              ¥{formatAmount(item.listing.priceCents)}
                            </Text>
                          </View>
                          {/*
                            市场计数行（稿 `.rstats`）：`浏览 N · 想要 N`。
                            Owner 2026-09-24 拍板：契约与 DB 都取不到这两个量时**显示 0**，
                            不整行隐藏 —— 稿要这一行，少一行比少一个数字更像漏做。
                            `?? 0` 落在**渲染层**，所以这里看起来「接线是好的」；真正的写入在
                            `features/listing/adapt.ts` 里硬写 `views: null` / `wants: null`
                            （那里禁止编造业务数据）。**#192 要改的是 `adapt.ts`，不是这里** ——
                            别看到这一行就以为把契约字段补上这条路径就会自动活过来。
                            另：本页与 `product-card` / `listings-detail` 的口径**不同**
                            （那两处是 `=== null ? null`，整块不画），这是拍板后的有意分歧。
                          */}
                          <View className="ml__rstats">
                            <Text className="ml__rstat num">
                              {`浏览 ${item.listing.views ?? 0}`}
                            </Text>
                            <View className="ml__dot" />
                            <Text className="ml__rstat num">{`想要 ${item.listing.wants ?? 0}`}</Text>
                          </View>
                          {/*
                            待确认卡片多一行（稿 `.rreq`）：谁在等、等了多久 —— 卖家点
                            「同意 / 拒绝」的依据。没有提案的待确认（已同意、待面交）不画这一行，
                            换成一句说明，否则那张卡上会出现一行空白，看起来像少渲染了东西。
                          */}
                          {item.segment === 'pending' ? (
                            item.proposal ? (
                              <Text className="ml__rreq">
                                <Text className="ml__rreq-b">{item.proposal.buyerName}</Text>
                                {` 点了「我想要」 · ${relativeTimeOf(item.proposal.createdAt, now)} · ¥${formatAmount(item.proposal.amountCents)}`}
                              </Text>
                            ) : (
                              <Text className="ml__rreq">已同意 · 等面交（去订单页取交易码）</Text>
                            )
                          ) : null}
                        </View>
                      </View>

                      <View
                        className={`ml__acts${END_ALIGNED.includes(item.segment) ? ' ml__acts--end' : ''}`}
                      >
                        {/* 锁定说明只给「已售出」（稿 ⑥ 的 LOCK 表）：「待确认」的「先别改」
                            由上面那行「谁在等」加决策按钮表达，不挂锁图标 */}
                        {lockNote(item.segment) ? (
                          <View className="ml__locks">
                            <View className="ml__lock-ic" />
                            <Text>{lockNote(item.segment)}</Text>
                          </View>
                        ) : null}

                        {/* 编辑只给在售 / 已下架两段（改文案与价格）。
                            待确认与已售出不可编辑，点击走 `edit` 里的说明分支 */}
                        {item.segment === 'sale' || item.segment === 'off' ? (
                          <View className="ml__act" onClick={() => edit(item)}>
                            <Text>编辑</Text>
                          </View>
                        ) : null}

                        {item.segment === 'pending' ? (
                          <>
                            {/* `act-first`（稿 `.act-first{margin-right:auto}`）：查看会话靠左，
                                拒绝 / 同意靠右 —— 三按钮时左起排会挤在一起，看不出主次 */}
                            <View
                              className="ml__act ml__act--first"
                              onClick={() => openConversation(item)}
                            >
                              <Text>查看会话</Text>
                            </View>
                            {item.proposal ? (
                              <>
                                <View
                                  className={`ml__act${pendingBusy !== null ? ' is-busy' : ''}`}
                                  onClick={() => declineProposal(item)}
                                >
                                  <Text>拒绝</Text>
                                </View>
                                <View
                                  className={`ml__act ml__act--primary${
                                    pendingBusy !== null ? ' is-busy' : ''
                                  }`}
                                  onClick={() => acceptProposal(item)}
                                >
                                  <Text>同意</Text>
                                </View>
                              </>
                            ) : null}
                          </>
                        ) : null}

                        {item.segment === 'sold' ? (
                          <>
                            <View className="ml__act" onClick={() => openConversation(item)}>
                              <Text>查看会话</Text>
                            </View>
                            <View
                              className={`ml__act ml__act--primary${
                                relistBusy === item.listing.id ? ' is-busy' : ''
                              }`}
                              onClick={() => relist(item)}
                            >
                              <Text>再次上架</Text>
                            </View>
                          </>
                        ) : null}

                        {item.segment === 'off' ? (
                          <View
                            className={`ml__act ml__act--primary${
                              relistBusy === item.listing.id ? ' is-busy' : ''
                            }`}
                            onClick={() => relist(item)}
                          >
                            <Text>重新上架</Text>
                          </View>
                        ) : null}

                        {item.segment === 'sale' ? (
                          <View
                            className="ml__act ml__act--danger"
                            onClick={() => setConfirming(item)}
                          >
                            <Text>下架</Text>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>

                {/*
                  到底提示（1版稿 `.list-end`）：小程序「加载完毕」语义，N 是**当前这一段**的件数。
                  只在「这份列表确实是全部」时才有意义 —— 列表不完整时它是一句假话（见 truncated），
                  待确认没读到时同理（那一句会数错待确认段）。
                */}
                {!loading && !truncated && countsReliable ? (
                  <View className="ml__end">
                    <View className="ml__end-line" />
                    <Text className="ml__end-tx num">{`已经到底了 · ${shown.length} 件${segmentLabel(segment)}`}</Text>
                    <View className="ml__end-line" />
                  </View>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </View>

      <View className="ml__fab" onClick={goPublish}>
        <Image className="ml__fab-ic" src={ICONS.plusLine} mode="aspectFit" />
        <Text>发布</Text>
      </View>

      {/* 回到顶部：稿 ⑧，滚过一屏后浮现，压在发布钮之上（见 index.scss 的定位） */}
      <View className={`ml__totop${showTop ? ' is-show' : ''}`} onClick={backToTop}>
        <View className="ml__totop-arrow" />
      </View>

      {/* ---------------- 下架二次确认（居中卡，稿 ⑤ 的真状态机） ---------------- */}
      {confirming ? (
        <>
          <View className="ml__scrim" onClick={() => setConfirming(null)} />
          <View className="ml__dialog">
            <Text className="ml__dialog-title">确认下架这件商品？</Text>
            <Text className="ml__dialog-sub">
              下架后买家在首页与搜索里都看不到它，已有的会话不受影响。
            </Text>

            <View className="ml__dlg-item">
              <View className="ml__dlg-thumb">
                <Image
                  className="ml__dlg-thumb-img"
                  src={confirming.listing.coverUrl}
                  mode="aspectFill"
                />
              </View>
              <View className="ml__dlg-main">
                <Text className="ml__dlg-title">{confirming.listing.title}</Text>
                <Text className="ml__dlg-price num">
                  ¥{formatAmount(confirming.listing.priceCents)}
                </Text>
              </View>
            </View>

            <View className="ml__dlg-tip">
              <Text>
                下架是可恢复操作：之后在「已下架」里点「重新上架」，即可把商品信息带进出物页重新发布。
                已有的会话不受影响。
              </Text>
            </View>

            <View className="ml__dlg-acts">
              <View
                className="ml__dlg-cancel"
                onClick={() => {
                  setConfirming(null)
                  setSubmit('idle')
                }}
              >
                <Text>取消</Text>
              </View>
              <View
                className={`ml__dlg-ok${submit === 'busy' ? ' is-busy' : ''}${
                  submit === 'failed' ? ' is-failed' : ''
                }`}
                onClick={confirmOffline}
              >
                {submit === 'busy' ? <View className="ml__spin" /> : null}
                <Text>
                  {submit === 'busy' ? '下架中' : submit === 'failed' ? '重试' : '确认下架'}
                </Text>
              </View>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
