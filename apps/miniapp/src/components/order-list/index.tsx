import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import LoadError from '@/components/load-error'
import type { OrderCardView } from '@/features/transaction/adapt'
import { countsOf, type StatusKey, shownOf } from '@/features/transaction/useOrderList'
import { formatAmount } from '@/mock/api'
import './index.scss'

/**
 * 订单列表本体（`pages/orders-buy` 与 `pages/orders-sell` 共用）。
 *
 * 两页只有「视角」不同（我买到的 / 我卖出的），其余完全一样：4 个状态 tab、
 * 区块标题行 + 排序开关、订单卡、骨架屏、两支空态、到底提示、回到顶部钮。
 * 页面只负责 Taro 的页面级 hook（登录守卫、首次加载、下拉刷新、滚动）与数据，
 * 这里负责筛选/排序这两项纯 UI 状态与全部渲染。
 *
 * **样式块名仍是 `.orders__`**（订单页的块名）：组件只是把它从页面里挪出来给两页共用，
 * 换名字对观感没有收益，只会把 diff 撑大。见 `index.scss` 的文件头。
 *
 * 数据来源是真实接口（`GET /transactions`，见 `features/fetchers.ts` 的 `loadOrders`），
 * 只有开发 / 预览构建才允许回退 mock —— 这一层不关心，它只认 `items` / `failed`。
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

/**
 * 「回到顶部」钮的出现阈值。
 *
 * 1版稿 `.totop` 是在**内部滚动容器**上按 `scrollTop > 320` 判的（`.content{overflow-y:auto}`），
 * 本页是页面级滚动、`usePageScroll` 给的是逻辑 px（= 稿的 pt），两者不是同一把尺子；
 * 而且仓库对「页面级滚动列表」已经有同口径先例（`pages/chat/index.tsx` 的 380），
 * 所以这里跟先例走，不照抄稿的 320 —— 阈值只影响按钮早出现还是晚出现，观感差约一成。
 */
export const TOTOP_THRESHOLD = 380

type Props = {
  items: OrderCardView[]
  loading: boolean
  /**
   * 真实接口失败且没有回退 mock。列表里还有数据时把错误态**追加在列表上方**，
   * 一条都没有时才用它顶替列表（见下面 LoadError 那段的说明）。
   */
  failed: boolean
  /** 列表不完整（翻页到上限，或服务端游标没前进） */
  truncated: boolean
  /** 回到顶部钮是否已浮现（由页面的 `usePageScroll` 驱动） */
  showTop: boolean
  onRetry: () => void
}

export default function OrderList({ items, loading, failed, truncated, showTop, onRetry }: Props) {
  const [status, setStatus] = useState<StatusKey>('ALL')
  const [sortDesc, setSortDesc] = useState(true)

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
   * 「查看会话」跳的是**这一笔**的会话，而不是同商品其他买家的会话 —— 这是本页的验收要点。
   * 真实数据直接消费契约的 `conversationId`；mock 回退里按 (listingId, 对方) 解析，
   * 解析不到（投影层给 `null`）按「目标已失效」提示。
   */
  const openConversation = (item: OrderCardView) => {
    if (!item.conversationId) {
      void Taro.showToast({ title: '这笔交易的会话已失效', icon: 'none' })
      return
    }
    void Taro.navigateTo({ url: `/pages/conversation/index?id=${item.conversationId}` })
  }

  const openMeetup = (item: OrderCardView) => {
    void Taro.navigateTo({ url: `/pages/transaction-meetup/index?id=${item.id}` })
  }

  const openListing = (item: OrderCardView) => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.listingId}` })
  }

  /** 评价：契约里没有评价 / 评分域（`packages/contracts/src/` 只有 comments），纯占位 */
  const reviewOrder = () => {
    void Taro.showToast({ title: '评价待接入', icon: 'none' })
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  return (
    <View className="orders">
      <ScrollView className="orders__filters" scrollX enableFlex>
        <View className="orders__filters-inner">
          {STATUS_TABS.map((tab) => (
            <View
              key={tab.key}
              // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child）
              className={`orders__pill orders__pill--${tab.key}${
                tab.key === status ? ' is-on' : ''
              }`}
              onClick={() => setStatus(tab.key)}
            >
              <Text>{tab.label}</Text>
              {/* 计数跟着正在显示的那份列表走：加载中 / 列表不完整时不显示数字 */}
              {showCounts ? <Text className="orders__pill-cnt num">{counts[tab.key]}</Text> : null}
            </View>
          ))}
        </View>
      </ScrollView>

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
                    <Text className={`orders__st ${meta.cls}`}>{meta.label}</Text>
                  </View>

                  <View className="orders__mid" onClick={() => openListing(item)}>
                    <View className="orders__thumb">
                      {item.listing.coverUrl ? (
                        <Image
                          className="orders__thumb-img"
                          src={item.listing.coverUrl}
                          mode="aspectFill"
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
                        {/* 只有已完成能评价（已取消没有可评价的成交） */}
                        {item.status === 'COMPLETED' ? (
                          <View className="orders__btn orders__btn--sec" onClick={reviewOrder}>
                            <Image
                              className="orders__btn-ic"
                              src={ICONS.starAccent}
                              mode="aspectFit"
                            />
                            <Text>评价</Text>
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

      <View className={`orders__totop${showTop ? ' is-show' : ''}`} onClick={backToTop}>
        <View className="orders__totop-arrow" />
      </View>
    </View>
  )
}
