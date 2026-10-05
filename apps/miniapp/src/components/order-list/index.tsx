import {
  REVIEW_BODY_MAX,
  type TransactionReviewRating,
} from '@fish/contracts/transaction-reviews/schema'
import { Image, Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import BackTop from '@/components/back-top'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import type { FailureKind } from '@/features/load-failure'
import type { OrderCardView } from '@/features/transaction/adapt'
import {
  cancelTransaction,
  createTransactionReview,
  fetchMyTransactionReview,
} from '@/features/transaction/api'
import { countsOf, type StatusKey, shownOf } from '@/features/transaction/useOrderList'
import { formatAmount } from '@/lib/money'
import { isApiError } from '@/lib/request'
import './index.scss'

/**
 * 订单列表本体（`pages/orders-buy` 与 `pages/orders-sell` 共用）。
 *
 * 两页只有「视角」不同（标题与列表数据的 `role`），其余完全一样：玻璃顶栏 +
 * 4 个状态 tab、区块标题行 + 排序开关、订单卡、骨架屏、两支空态、到底提示、
 * 回到顶部钮。页面只负责 Taro 的页面级 hook（登录守卫、首次加载、下拉刷新、
 * 滚动）与数据，这里负责筛选/排序这两项纯 UI 状态与全部渲染。
 *
 * **顶部区域（#386 第一批）**：与「我的发布」同款 —— `components/top-bar` 的 glass
 * 变体（返回钮 + 居中双色标题，`titleAlign="center"` 由组件下发），4 个状态 tab 进
 * 顶栏副行（`below` 槽）与主行连成**同一块玻璃**，列表从玻璃底下滚过。原先两页的
 * 微信原生导航栏已撤（页面 config 不再覆盖 `navigationStyle`），视角由页面传进来的
 * 标题表达。TopBar 放在组件里而不是两个页面里：两页顶部完全一致，改一处两页生效。
 *
 * **样式块名仍是 `.orders__`**（订单页的块名）：组件只是把它从页面里挪出来给两页共用，
 * 换名字对观感没有收益，只会把 diff 撑大。见 `index.scss` 的文件头。
 *
 * 数据来源是真实接口（`GET /transactions`，见 `features/fetchers.ts` 的 `loadOrders`），
 * 只有显式 `TARO_APP_MOCK=1` 的演示构建才允许回退 mock（#304 起 `NODE_ENV=development`
 * 不再打开兜底）—— 这一层除此之外只认数据、`failed` 与 `failureKind`。
 */

/** 4 个状态 tab（1版稿的筛选胶囊） */
const STATUS_TABS: { key: StatusKey; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'PENDING_MEETUP', label: '待面交' },
  { key: 'COMPLETED', label: '已完成' },
  { key: 'CANCELLED', label: '已取消' },
]

/** 区块标题（1版稿 `SEC` 表）与到底提示的后缀同源，只在这里写一遍 */
const SECTION_TITLE: Record<StatusKey, string> = {
  ALL: '全部订单',
  PENDING_MEETUP: '待面交订单',
  COMPLETED: '已完成订单',
  CANCELLED: '已取消订单',
}

/**
 * 状态胶囊的文案与配色（1版稿：待面交品牌蓝 / 已完成灰 / 已取消灰底描边）。
 *
 * `note` 是**带结果日期那行**的后半句（前面接「已于 2026-09-14」）；`noteNoTime` 是
 * 拿不到结果时间时单独成句的版本（契约保证终态必带结果时间，mock fixture 也补齐了，
 * 所以正常不会走到 —— 留着是为了投影层真给 `null` 时不显示半句话）。
 */
const STATUS_META: Record<
  OrderCardView['status'],
  { label: string; cls: string; note: string; noteNoTime: string }
> = {
  PENDING_MEETUP: { label: '待面交', cls: 'is-pending', note: '', noteNoTime: '' },
  COMPLETED: { label: '已完成', cls: 'is-done', note: '完成面交', noteNoTime: '已完成面交' },
  CANCELLED: { label: '已取消', cls: 'is-cancel', note: '取消交易', noteNoTime: '已取消交易' },
}

/** 评价的三档（#195 冻结口径：好评 / 中评 / 差评，不是 1–5 星） */
const REVIEW_TIERS: { key: TransactionReviewRating; label: string }[] = [
  { key: 'POSITIVE', label: '好评' },
  { key: 'NEUTRAL', label: '中评' },
  { key: 'NEGATIVE', label: '差评' },
]

type Props = {
  /** 顶栏标题的黑色前段与品牌色尾段：两页各传自己的视角词（我 + 买到的 / 卖出的） */
  title: string
  titleEm: string
  items: OrderCardView[]
  loading: boolean
  /**
   * 真实接口失败且没有回退 mock。列表里还有数据时把错误态**追加在列表上方**，
   * 一条都没有时才用它顶替列表（见下面 LoadError 那段的说明）。
   */
  failed: boolean
  /** 失败分类（#304）：转给 `LoadError` 换文案（401 / 网络 / 服务端各不相同） */
  failureKind: FailureKind | null
  /** 列表不完整（翻页到上限，或服务端游标没前进） */
  truncated: boolean
  /** 回到顶部钮是否已浮现（由页面的 `usePageScroll` 驱动） */
  showTop: boolean
  onRetry: () => void
  /**
   * 卡上写操作（取消交易 / 提交评价）成功后的重拉：由页面把 `useOrderList` 的
   * `reload` 传进来。不传则只做本地提示（组件在两个页面外不可复用，两页都会传）。
   */
  onRefresh?: () => void
}

export default function OrderList({
  title,
  titleEm,
  items,
  loading,
  failed,
  failureKind,
  truncated,
  showTop,
  onRetry,
  onRefresh,
}: Props) {
  const [status, setStatus] = useState<StatusKey>('ALL')
  const [sortDesc, setSortDesc] = useState(true)

  /* ------- 卡上写操作（#195 评价 + 取消交易）的在飞与弹层状态 ------- */

  /** 取消交易在飞（挡连点；showModal 的确认回调是跨帧的，用状态而不是 ref 才能画出来） */
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null)
  /** 评价弹层的目标（null = 关闭） */
  const [reviewTarget, setReviewTarget] = useState<OrderCardView | null>(null)
  const [reviewTier, setReviewTier] = useState<TransactionReviewRating | null>(null)
  const [reviewBody, setReviewBody] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  /** 本次会话里已提交过评价的交易（本地提示位；权威状态以点开时的 GET 评价边为准） */
  const [reviewedIds, setReviewedIds] = useState<string[]>([])
  /** 点「评价」后正在查评价边（挡连点） */
  const [reviewCheckingId, setReviewCheckingId] = useState<string | null>(null)

  const counts = useMemo(() => countsOf(items), [items])
  const shown = useMemo(() => shownOf(items, status, sortDesc), [items, status, sortDesc])

  /**
   * 计数与「列表不完整」那行**跟着正在显示的数据**（`items` / `truncated`）走，不看 `failed`：
   * 刷新失败但列表还在显示时，计数描述的正是这份列表，藏起来反而自相矛盾。
   * 首次加载失败时 `items` 为空，两者自然都不显示。
   */
  const showCounts = !loading && !truncated && items.length > 0
  const emptyRole = items.length === 0

  /**
   * 切状态分段：回到列表顶部（与 mylist 的 pickSegment / history 的 pickTab 同一口径）。
   * 分段挪进固定顶栏后，列表滚到多深都能直接切 —— 换段等于换了一份列表，
   * 停在上一段的滚动位置会落在新列表的尾部或半空。
   */
  const pickStatus = (key: StatusKey) => {
    setStatus(key)
    void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })
  }

  /**
   * 演示来源的卡**不接入真实交易链路**（#304 / #182，Owner 定版：禁用并说明）。
   *
   * 演示构建（`TARO_APP_MOCK=1`）里后端挂掉时列表会整片换成 fixture（`source === 'demo'`），
   * 那些订单的 id 是 `t-*` 假 id：拿去跳真实面交页就是 404「找不到这笔交易」，
   * 拿去打取消 / 评价接口只会得到一个与这张卡无关的服务端错误。
   * 所以「打开二维码」「查看会话」「取消交易」「评价」这四条路径统一在这里拦下 ——
   * 只说明，不发请求、不跳页。（评价弹层的目标只由 `openReview` 设置，那里已拦，
   * 所以 `submitReview` 不必再判一次。）
   *
   * 拦在**点击时**而不是把按钮藏掉：藏了用户会以为功能没了；点一下被告知「这是演示数据」，
   * 才知道自己看的是一份不会被后端承认的列表。
   *
   * `openListing`（商品详情）不拦：Owner 决策只点了「二维码 / 交易码」与「查看会话」两条
   * 交易入口，而商品详情本来就有自己的演示兜底 —— 假 `l-*` 会先打一次真实
   * `GET /listings/:id`（失败）再落到详情页的 mock（`demoListingDetail`），页面能正常打开。
   */
  const demoBlocked = (item: OrderCardView): boolean => {
    if (item.source !== 'demo') return false
    void Taro.showToast({ title: '演示数据，不接入真实交易', icon: 'none' })
    return true
  }

  /**
   * 「查看会话」跳的是**这一笔**的会话，而不是同商品其他买家的会话 —— 这是本页的验收要点。
   * 真实数据直接消费契约的 `conversationId`；mock 回退里按 (listingId, 对方) 解析，
   * 解析不到（投影层给 `null`）按「目标已失效」提示。
   */
  const openConversation = (item: OrderCardView) => {
    if (demoBlocked(item)) return
    if (!item.conversationId) {
      void Taro.showToast({ title: '这笔交易的会话已失效', icon: 'none' })
      return
    }
    void Taro.navigateTo({ url: `/pkg-social/pages/conversation/index?id=${item.conversationId}` })
  }

  const openMeetup = (item: OrderCardView) => {
    if (demoBlocked(item)) return
    void Taro.navigateTo({ url: `/pkg-trade/pages/transaction-meetup/index?id=${item.id}` })
  }

  const openListing = (item: OrderCardView) => {
    void Taro.navigateTo({ url: `/pkg-browse/pages/listing-detail/index?id=${item.listingId}` })
  }

  /**
   * 「取消交易」：双方都可调，仅待面交（PENDING_MEETUP）的卡有这个钮。
   * `POST /transactions/:id/cancel` 幂等（已取消的重复取消返回现状），COMPLETED 上 409。
   * 二级确认后真发，成功后 `onRefresh` 重拉 —— 不本地翻转状态（服务端返回才是权威）。
   */
  const cancelOrder = (item: OrderCardView) => {
    if (demoBlocked(item)) return
    if (cancelBusyId !== null) return
    void Taro.showModal({
      title: '取消这笔交易？',
      content: '取消后订单作废，商品回到在售；对方也会收到通知。',
      confirmColor: '#e5484d',
    })
      .then(async (result) => {
        if (!result.confirm) return
        setCancelBusyId(item.id)
        try {
          await cancelTransaction(item.id)
          void Taro.showToast({ title: '已取消交易', icon: 'none' })
          onRefresh?.()
        } catch (caught) {
          void Taro.showToast({
            title: isApiError(caught) ? caught.message : '取消没成功，请重试',
            icon: 'none',
          })
        } finally {
          setCancelBusyId(null)
        }
      })
      .catch(() => {})
  }

  /**
   * 「评价」：先读评价边 —— 已评过（200）就说明，不再弹层（评价不可修改，
   * 重复提交会被 409 `TRANSACTION_REVIEW_EXISTS` 拒，与其撞墙不如先问）；
   * 没有（404 `REVIEW_NOT_FOUND`）才弹评价卡。
   */
  const openReview = (item: OrderCardView) => {
    if (demoBlocked(item)) return
    if (reviewCheckingId !== null || reviewBusy) return
    setReviewCheckingId(item.id)
    fetchMyTransactionReview(item.id)
      .then(() => {
        // 已评过：把这张卡也转成「已评价」，别让用户对同一笔交易反复探测
        setReviewedIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]))
        void Taro.showToast({ title: '这笔交易已经评价过了', icon: 'none' })
      })
      .catch((caught: unknown) => {
        if (isApiError(caught) && caught.code === 'REVIEW_NOT_FOUND') {
          setReviewTier(null)
          setReviewBody('')
          setReviewTarget(item)
          return
        }
        void Taro.showToast({
          title: isApiError(caught) ? caught.message : '没读到评价状态，请重试',
          icon: 'none',
        })
      })
      .finally(() => setReviewCheckingId(null))
  }

  /** 提交评价。评语 trim 后为空 = 「只打分没写字」（契约明说的正常形态），省略字段。 */
  const submitReview = () => {
    if (reviewTarget === null || reviewBusy) return
    // 没选档位：按钮只是降了透明度（`is-off`），点下去不能静默什么都不发生 ——
    // 本页其它写操作都会给一句 toast，这里补齐同一口径
    if (reviewTier === null) {
      void Taro.showToast({ title: '请先选好评 / 中评 / 差评', icon: 'none' })
      return
    }
    setReviewBusy(true)
    const trimmed = reviewBody.trim()
    createTransactionReview(reviewTarget.id, {
      rating: reviewTier,
      ...(trimmed === '' ? {} : { body: trimmed }),
    })
      .then(() => {
        void Taro.showToast({ title: '评价已提交', icon: 'none' })
        setReviewedIds((prev) => [...prev, reviewTarget.id])
        setReviewTarget(null)
      })
      .catch((caught: unknown) => {
        // 422 REVIEW_CONTENT_BLOCKED / 409 已评过等服务端可读文案原样透出
        void Taro.showToast({
          title: isApiError(caught) ? caught.message : '提交没成功，请重试',
          icon: 'none',
        })
      })
      .finally(() => setReviewBusy(false))
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  return (
    <View className="orders">
      {/*
        两级顶栏合一（与 pages/mylist 同款）：一级栏 = 返回 + 居中双色标题 + 微信胶囊，
        二级栏 = 4 段状态分段；两栏一起钉在屏顶、都不参与滚动，列表从玻璃底下滚过。
        右侧避让（原生胶囊）由组件按运行时读到的胶囊位置下发，这里不管。
      */}
      <TopBar
        variant="glass"
        spacer
        back
        titleAlign="center"
        title={title}
        titleEm={titleEm}
        below={
          <View className="orders__filters">
            <View className="orders__filters-inner">
              {STATUS_TABS.map((tab) => (
                <View
                  key={tab.key}
                  // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child）
                  className={`orders__pill orders__pill--${tab.key}${
                    tab.key === status ? ' is-on' : ''
                  }`}
                  onClick={() => pickStatus(tab.key)}
                >
                  <Text>{tab.label}</Text>
                  {/* 计数跟着正在显示的那份列表走：加载中 / 列表不完整时不显示数字 */}
                  {showCounts ? (
                    <Text className="orders__pill-cnt num">{counts[tab.key]}</Text>
                  ) : null}
                </View>
              ))}
            </View>
          </View>
        }
      />
      {/* 副行占位：组件的 `spacer` 只含主行，分段这一截页面自补（见 index.scss） */}
      <View className="orders__header-gap" />

      {/*
        列表不完整时才说的那句实话：翻页到上限或服务端游标没前进时，这份列表不是全部，
        所以既不显示计数、也不显示「已经到底了」。加载失败由下面的 LoadError 承担。
      */}
      {!loading && truncated ? (
        <Text className="orders__partial num">{`交易较多 · 仅显示最近 ${items.length} 笔`}</Text>
      ) : null}

      <View className="orders__sec">
        <Text className="orders__sec-title">{loading ? '订单' : SECTION_TITLE[status]}</Text>
        <View className="orders__sort" onClick={() => setSortDesc((prev) => !prev)}>
          <Text>{`按创建时间${sortDesc ? '倒序' : '正序'}`}</Text>
          <View className={`orders__sort-chev${sortDesc ? '' : ' is-asc'}`} />
        </View>
      </View>

      <View className="orders__list">
        {loading
          ? // 2 张骨架卡（1版稿的 skelHTML 就是 2 张），正好让下面的「正在读取订单…」留在首屏
            [0, 1].map((i) => (
              <View key={`sk-${i}`} className="orders__skel">
                <View className="orders__skel-top">
                  <View className="orders__skel-av" />
                  <View className="orders__skel-bar" style={{ width: '160px' }} />
                  <View className="orders__skel-pill" />
                </View>
                <View className="orders__skel-mid">
                  <View className="orders__skel-sq" />
                  <View className="orders__skel-lines">
                    <View className="orders__skel-bar" />
                    <View className="orders__skel-bar" style={{ width: '60%' }} />
                    <View className="orders__skel-amount" />
                  </View>
                </View>
                <View className="orders__skel-foot">
                  <View className="orders__skel-btn" />
                  <View className="orders__skel-btn" />
                </View>
              </View>
            ))
          : null}

        {loading ? (
          <View className="orders__skel-hint">
            <View className="orders__spin" />
            <Text>正在读取订单…</Text>
          </View>
        ) : null}

        {/*
          接口失败且没有回退 mock：这一页是「加载不出来」，不是「恰好没有订单」。
          但**已经加载好的列表不能因为一次失败就整片消失** —— 下拉刷新失败时
          `useOrderList` 是保留 `items` 的（keepList 的用意就是别让用户丢掉阅读位置），
          所以这里只在「一条都没有」时用错误态顶替列表，否则把它放在列表上方当一条提示。
        */}
        {!loading && failed ? (
          <LoadError
            onRetry={onRetry}
            // 401 / 网络不可用 / 服务端错误信封各自换文案（#304），不再都写「检查网络后重试」
            kind={failureKind ?? undefined}
            // 列表还在时说明这是上一次成功加载的结果，别让人以为「下面这些是刚拿到的」
            text={items.length > 0 ? '以下为上次加载的订单' : undefined}
          />
        ) : null}

        {!loading && !failed && shown.length === 0 ? (
          <View className={`orders__empty${emptyRole ? '' : ' orders__empty--inline'}`}>
            <View className="orders__empty-disc">
              <Image className="orders__empty-ic" src={ICONS.order} mode="aspectFit" />
            </View>
            <Text className="orders__empty-title">
              {emptyRole
                ? '还没有订单'
                : // 列表不完整时不能说「该筛选下没有订单」—— 那是用已知不完整的数据下结论
                  truncated
                  ? '已加载的订单里没有这一状态'
                  : '这个筛选下还没有订单'}
            </Text>
            <Text className="orders__empty-text">
              {emptyRole
                ? '在会话里和对方达成交易后，订单会出现在这里，面交时扫码并填入商家给的交易码即可核实。'
                : '换个状态看看，或者回到全部订单。'}
            </Text>
            <View
              className="orders__empty-act"
              onClick={() => {
                if (emptyRole) {
                  void Taro.switchTab({ url: '/pages/home/index' })
                  return
                }
                setStatus('ALL')
                void Taro.showToast({ title: '已显示全部订单', icon: 'none' })
              }}
            >
              <Text>{emptyRole ? '去首页看看' : '查看全部订单'}</Text>
            </View>
          </View>
        ) : null}

        {/* 失败但手里还有已加载的列表：照常渲染，错误态在上面那条 */}
        {!loading && (!failed || items.length > 0)
          ? shown.map((item) => {
              const meta = STATUS_META[item.status]
              const pending = item.status === 'PENDING_MEETUP'
              return (
                <View key={item.id} className="orders__card">
                  <View className="orders__top">
                    <View className="orders__av">
                      <Text className="orders__av-tx">{item.counterpart.nickname.slice(0, 1)}</Text>
                      {item.counterpart.verified ? <View className="orders__av-badge" /> : null}
                    </View>
                    <Text className="orders__oname">{item.counterpart.nickname}</Text>
                    {/*
                      演示来源角标（#304）：这张卡的 id 是 `t-*` 假 id，不会被后端承认。
                      角标是**唯一**的全局提示 —— 点上面四个入口也会再说明一次，但用户
                      应该在点之前就知道自己看的是一份演示列表。
                    */}
                    {item.source === 'demo' ? <Text className="orders__src">演示数据</Text> : null}
                    <Text className={`orders__st ${meta.cls}`}>{meta.label}</Text>
                  </View>

                  <View className="orders__mid" onClick={() => openListing(item)}>
                    <View className="orders__thumb">
                      {item.listing.coverUrl ? (
                        <Image
                          className="orders__thumb-img"
                          src={item.listing.coverUrl}
                          mode="aspectFill"
                          lazyLoad
                        />
                      ) : null}
                    </View>
                    <View className="orders__info">
                      <Text className="orders__otitle">{item.listing.title}</Text>
                      <View className="orders__price">
                        <Text className="orders__olabel">议价成交</Text>
                        <Text className="orders__amount num">
                          ¥{formatAmount(item.amountCents)}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View className="orders__foot">
                    {pending ? (
                      <>
                        <View
                          className="orders__btn orders__btn--ghost"
                          onClick={() => openConversation(item)}
                        >
                          <Image className="orders__btn-ic" src={ICONS.chatInk} mode="aspectFit" />
                          <Text>查看会话</Text>
                        </View>
                        {/* 取消是双方的动作，放次级危险位：真发 DELETE 语义的写端点前有二级确认 */}
                        <View
                          className={`orders__btn orders__btn--danger${
                            cancelBusyId === item.id ? ' is-busy' : ''
                          }`}
                          onClick={() => cancelOrder(item)}
                        >
                          <Text>{cancelBusyId === item.id ? '取消中' : '取消交易'}</Text>
                        </View>
                        {/* 两头的入口不一样：买家去扫卖家的码，卖家把自己的码亮给买家 */}
                        <View
                          className="orders__btn orders__btn--pri"
                          onClick={() => openMeetup(item)}
                        >
                          <Image className="orders__btn-ic" src={ICONS.qr} mode="aspectFit" />
                          <Text>{item.role === 'buyer' ? '打开二维码' : '打开交易码'}</Text>
                        </View>
                      </>
                    ) : (
                      <>
                        {/* 卡片只留结果日期，不显示创建时间 */}
                        <Text className="orders__note num">
                          {item.settledDate
                            ? `已于 ${item.settledDate} ${meta.note}`
                            : meta.noteNoTime}
                        </Text>
                        {/* 只有已完成能评价（已取消没有可评价的成交）；已评过转灰不可再点 */}
                        {item.status === 'COMPLETED' ? (
                          <View
                            className={`orders__btn orders__btn--sec${
                              reviewedIds.includes(item.id) ? ' is-done' : ''
                            }`}
                            onClick={() => {
                              if (reviewedIds.includes(item.id)) return
                              openReview(item)
                            }}
                          >
                            <Image
                              className="orders__btn-ic"
                              src={ICONS.starAccent}
                              mode="aspectFit"
                            />
                            <Text>{reviewedIds.includes(item.id) ? '已评价' : '评价'}</Text>
                          </View>
                        ) : null}
                        <View
                          className="orders__btn orders__btn--sec"
                          onClick={() => openConversation(item)}
                        >
                          <Image className="orders__btn-ic" src={ICONS.chatInk} mode="aspectFit" />
                          <Text>查看会话</Text>
                        </View>
                      </>
                    )}
                  </View>
                </View>
              )
            })
          : null}

        {/*
          评价卡（#195）：三档评分（好评/中评/差评，契约冻结口径）+ 可空评语。
          先读评价边再弹（已评过 409 会被服务端拒，与其撞墙不如先问）；
          提交成功后本地把该卡转「已评价」，权威状态以服务端为准。
        */}
        {reviewTarget !== null ? (
          <>
            <View
              className="orders__scrim"
              onClick={() => {
                if (!reviewBusy) setReviewTarget(null)
              }}
            />
            <View className="orders__dialog">
              <Text className="orders__dlg-title">评价这笔交易</Text>
              <Text className="orders__dlg-sub">{reviewTarget.listing.title}</Text>
              <View className="orders__dlg-tiers">
                {REVIEW_TIERS.map((tier) => (
                  <View
                    key={tier.key}
                    className={`orders__tier orders__tier--${tier.key.toLowerCase()}${
                      reviewTier === tier.key ? ' is-on' : ''
                    }`}
                    onClick={() => setReviewTier(tier.key)}
                  >
                    <Text>{tier.label}</Text>
                  </View>
                ))}
              </View>
              <View className="orders__dlg-bodywrap">
                <Textarea
                  className="orders__dlg-body"
                  maxlength={REVIEW_BODY_MAX}
                  placeholder="写点想说的（可不填，最多 200 字）"
                  value={reviewBody}
                  onInput={(event) => setReviewBody(event.detail.value)}
                />
              </View>
              <View className="orders__dlg-acts">
                <View
                  className="orders__dlg-cancel"
                  onClick={() => {
                    if (!reviewBusy) setReviewTarget(null)
                  }}
                >
                  <Text>再想想</Text>
                </View>
                <View
                  className={`orders__dlg-ok${reviewTier === null ? ' is-off' : ''}`}
                  onClick={submitReview}
                >
                  <Text>{reviewBusy ? '提交中…' : '提交评价'}</Text>
                </View>
              </View>
            </View>
          </>
        ) : null}

        {/*
          到底提示：只在「这份列表确实是全部」时才有意义 —— 加载中 / 空列表 / 列表不完整都不显示。
          判据与计数、partial 行一致：看正在显示的数据（`truncated` / `shown`），不看 `failed` ——
          刷新失败但列表还在时，末尾那句「已经到底了」描述的正是这份列表。
        */}
        {!loading && !truncated && shown.length > 0 ? (
          <View className="orders__end">
            <View className="orders__end-line" />
            <Text className="orders__end-text">
              {status === 'ALL'
                ? `已经到底了 · 共 ${shown.length} 笔`
                : `已经到底了 · ${shown.length} 笔${SECTION_TITLE[status].replace('订单', '')}`}
            </Text>
            <View className="orders__end-line" />
          </View>
        ) : null}
      </View>

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
