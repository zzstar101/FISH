import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import {
  type ConversationRole,
  fetchOrders,
  formatAmount,
  type MockTransaction,
  type OrderView,
  orderCounts,
  orderOverview,
} from '@/mock/api'
import './index.scss'

/**
 * A1 我的订单（设计稿 `设计稿_A1-orders.html`）。
 *
 * 视角（我买到的 / 我卖出的）× 状态（全部 / 待面交 / 已完成 / 已取消）两层筛选。
 * 状态计数来自 `orderCounts(role)`，所以每切一次视角，胶囊上的数字跟着变——
 * 与设计稿第 01/02 帧的差异一致（买入「全部 6」、卖出「全部 2」）。
 *
 * 「我是买家 / 我是卖家」直接消费交易的 `role`（契约里本来就有），不靠昵称或商品归属猜。
 * 「查看会话」跳的是 `transaction.conversationId`，即**这一笔**的会话，
 * 而不是同商品其他买家的会话——这是本页的验收要点。
 */

type StatusKey = 'ALL' | MockTransaction['status']

const STATUS_TABS: { key: StatusKey; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'PENDING_MEETUP', label: '待面交' },
  { key: 'COMPLETED', label: '已完成' },
  { key: 'CANCELLED', label: '已取消' },
]

/** 状态胶囊的文案与配色（设计稿：待面交品牌蓝 / 已完成灰 / 已取消灰底描边） */
const STATUS_META: Record<MockTransaction['status'], { label: string; cls: string; note: string }> =
  {
    PENDING_MEETUP: { label: '待面交', cls: 'is-pending', note: '' },
    COMPLETED: { label: '已完成', cls: 'is-done', note: '已完成面交' },
    CANCELLED: { label: '已取消', cls: 'is-cancel', note: '已取消交易' },
  }

const ROLE_TABS: { key: ConversationRole; label: string }[] = [
  { key: 'buyer', label: '我买到的' },
  { key: 'seller', label: '我卖出的' },
]

export default function Orders() {
  const [role, setRole] = useState<ConversationRole>('buyer')
  const [status, setStatus] = useState<StatusKey>('ALL')
  const [views, setViews] = useState<OrderView[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState<string | null>(null)

  const load = async (nextRole: ConversationRole) => {
    setLoading(true)
    setViews(await fetchOrders(nextRole))
    setLoading(false)
  }

  useLoad(() => {
    void load('buyer')
  })

  const overview = orderOverview()
  const counts = orderCounts(role)
  const countOf = (key: StatusKey): number => {
    if (key === 'ALL') return counts.all
    if (key === 'PENDING_MEETUP') return counts.pending
    if (key === 'COMPLETED') return counts.done
    return counts.cancelled
  }

  const shown = views.filter((item) => status === 'ALL' || item.transaction.status === status)

  const switchRole = (next: ConversationRole) => {
    if (next === role) return
    setRole(next)
    // 切视角时把状态筛选收敛回「全部」：两个视角的状态分布不同，
    // 保留上一个筛选容易出现「卖出视角 + 待面交 = 空列表」的困惑
    setStatus('ALL')
    void load(next)
  }

  const openConversation = (item: OrderView) => {
    void Taro.navigateTo({ url: `/pages/conversation/index?id=${item.transaction.conversationId}` })
  }

  const openMeetup = (item: OrderView) => {
    void Taro.navigateTo({ url: `/pages/transaction-meetup/index?id=${item.transaction.id}` })
  }

  /** 「确认完成」：真实实现要调后端，这里只做前置校验 + 反馈（不假装已成交） */
  const confirmDone = (item: OrderView) => {
    if (submitting) return
    setSubmitting(item.transaction.id)
    void Taro.showModal({
      title: '确认已完成面交？',
      content: `确认后这笔 ¥${formatAmount(item.transaction.amountCents)} 的交易将标记为已完成。`,
      confirmText: '确认完成',
      cancelText: '再想想',
    })
      .then((res) => {
        if (res.confirm) {
          void Taro.showToast({ title: '确认接口待接入', icon: 'none' })
        }
      })
      .finally(() => setSubmitting(null))
  }

  const openListing = (item: OrderView) => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.listing.id}` })
  }

  const headLabel = role === 'buyer' ? '我买到的' : '我卖出的'

  return (
    <View className="orders">
      <View className="orders__bg" />

      <NavBar />

      <View className="orders__head">
        <Text className="orders__title">
          我的<Text className="orders__title-hl">订单</Text>
        </Text>
        <Text className="orders__meta">
          共 <Text className="orders__meta-num">{overview.all}</Text> 笔交易 ·{' '}
          <Text className="orders__meta-num">{overview.pending}</Text> 笔待面交
        </Text>

        <View className="orders__seg">
          {ROLE_TABS.map((tab) => (
            <View
              key={tab.key}
              className={`orders__seg-item${tab.key === role ? ' is-on' : ''}`}
              onClick={() => switchRole(tab.key)}
            >
              <Text>{tab.label}</Text>
            </View>
          ))}
        </View>
      </View>

      <ScrollView className="orders__filters" scrollX enableFlex>
        <View className="orders__filters-inner">
          {STATUS_TABS.map((tab) => (
            <View
              key={tab.key}
              className={`orders__pill${tab.key === status ? ' is-on' : ''}`}
              onClick={() => setStatus(tab.key)}
            >
              <Text>{tab.label}</Text>
              <Text className="orders__pill-cnt num">{countOf(tab.key)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View className="orders__sec">
        <Text className="orders__sec-title">
          {`${STATUS_TABS.find((tab) => tab.key === status)?.label ?? '全部'}订单`}
        </Text>
        <Text className="orders__sec-note">按创建时间倒序</Text>
      </View>

      <View className="orders__list">
        {loading
          ? [0, 1, 2].map((i) => (
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
                  </View>
                </View>
              </View>
            ))
          : null}

        {!loading && shown.length === 0 ? (
          <View className="orders__empty">
            <View className="orders__empty-disc">
              <Image className="orders__empty-ic" src={ICONS.order} mode="aspectFit" />
            </View>
            <Text className="orders__empty-title">
              {status === 'ALL' ? `还没有${headLabel}的订单` : '该状态下没有订单'}
            </Text>
            <Text className="orders__empty-text">
              {role === 'buyer'
                ? '在首页看中东西后「聊一聊」，谈好价格就会生成一笔交易'
                : '把闲置发布出去，买家发起交易后就会出现在这里'}
            </Text>
            <View
              className="orders__empty-act"
              onClick={() =>
                void (role === 'buyer'
                  ? Taro.switchTab({ url: '/pages/home/index' })
                  : Taro.switchTab({ url: '/pages/sell/index' }))
              }
            >
              <Text>{role === 'buyer' ? '去逛逛' : '去发布'}</Text>
            </View>
          </View>
        ) : null}

        {!loading
          ? shown.map((item) => {
              const meta = STATUS_META[item.transaction.status]
              const pending = item.transaction.status === 'PENDING_MEETUP'
              return (
                <View key={item.transaction.id} className="orders__card">
                  <View className="orders__top">
                    <View className="orders__av">
                      <Text className="orders__av-tx">{item.counterpart.nickname.slice(0, 1)}</Text>
                      {item.counterpart.authStatus === 'VERIFIED' ? (
                        <View className="orders__av-badge" />
                      ) : null}
                    </View>
                    <Text className="orders__oname">{item.counterpart.nickname}</Text>
                    <Text className="orders__otag">
                      {item.transaction.role === 'buyer' ? '我是买家' : '我是卖家'}
                    </Text>
                    <Text className={`orders__st ${meta.cls}`}>{meta.label}</Text>
                  </View>

                  <View className="orders__mid" onClick={() => openListing(item)}>
                    <View className="orders__thumb">
                      <Image
                        className="orders__thumb-img"
                        src={item.listing.coverUrl}
                        mode="aspectFill"
                      />
                    </View>
                    <View className="orders__info">
                      <Text className="orders__otitle">{item.listing.title}</Text>
                      <Text className="orders__otime num">创建于 {item.transaction.timeLabel}</Text>
                      <View className="orders__price">
                        <Text className="orders__olabel">议价成交</Text>
                        <Text className="orders__amount num">
                          ¥{formatAmount(item.transaction.amountCents)}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View className="orders__foot">
                    {pending ? null : (
                      <Text className="orders__note num">
                        已于 {item.transaction.timeLabel} {meta.note}
                      </Text>
                    )}

                    <View
                      className="orders__btn orders__btn--ghost"
                      onClick={() => openConversation(item)}
                    >
                      <Text>查看会话</Text>
                    </View>

                    {pending ? (
                      <View
                        className="orders__btn orders__btn--pri"
                        onClick={() => openMeetup(item)}
                      >
                        <Image className="orders__btn-ic" src={ICONS.qr} mode="aspectFit" />
                        <Text>查看交易码</Text>
                      </View>
                    ) : null}

                    {pending ? (
                      <View
                        className={`orders__btn orders__btn--sec${
                          submitting === item.transaction.id ? ' is-off' : ''
                        }`}
                        onClick={() => confirmDone(item)}
                      >
                        <Image className="orders__btn-ic" src={ICONS.checkMuted} mode="aspectFit" />
                        <Text>{submitting === item.transaction.id ? '提交中…' : '确认完成'}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              )
            })
          : null}
      </View>
    </View>
  )
}
