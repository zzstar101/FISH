import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePageScroll } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import {
  type ConversationFilter,
  conversations,
  countByFilter,
  filterConversations,
  formatAmount,
  type MockConversation,
  unreadNotificationCount,
} from '@/mock/api'
import './index.scss'

/** 1版稿筛选纯文字 Tab（顺序：全部 / 通知 / 交易 / 许愿；「通知」= 系统会话） */
const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '通知' },
  { key: 'deal', label: '交易' },
  { key: 'wish', label: '许愿' },
]

/**
 * 系统会话（`kind === 'system'`）的展示名。
 *
 * mock 里这条会话的 `counterpartId` 是当前用户自己（`u-alan`），因为系统通知本来就没有
 * 「对方」；设计稿这一行写的是「鱼小应小助手」，所以这里按会话类型覆盖昵称。
 */
const SYSTEM_NAME = '鱼小应小助手'

/**
 * 回到顶部钮的出现阈值：1版稿 .totop 滚过 380pt 后出现。
 * `usePageScroll` 的单位是逻辑 px（= 稿的 pt），**不是** scss 里的 rpx，不 ×2。
 */
const TOTOP_THRESHOLD = 380

/**
 * 会话列表的消息预览。
 *
 * 交易类 SYSTEM 消息的 content 是契约里的 JSON 原文
 * （`{"type":"tx.proposal","amountCents":15000}` / `tx.accepted` / `tx.rejected`），
 * 列表里必须翻成中文，不能把 JSON 直接显示出来；解析失败（普通文本的系统消息，
 * 例如「你的学号认证已通过…」）按原文降级。
 */
function previewText(conversation: MockConversation): string {
  const last = conversation.lastMessage
  if (!last) return ''
  // 最后一条是媒体消息（D2）：lastMessage 只承载契约内的文本，媒体走 mediaPreview
  if (conversation.mediaPreview) return conversation.mediaPreview
  if (last.type !== 'SYSTEM') return last.content

  try {
    const event: unknown = JSON.parse(last.content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      if (type === 'tx.proposal') {
        const amount = (event as { amountCents?: unknown }).amountCents
        return typeof amount === 'number'
          ? `买家发起交易确认 · ¥${formatAmount(amount)}，待确认`
          : '买家发起交易确认，待确认'
      }
      if (type === 'tx.accepted') return '交易已确认 · 约定面交中'
      if (type === 'tx.rejected') return '卖家已拒绝本次议价'
      // 1版稿会话页的契约外演示事件（mock/chat.ts）：不映射的话 JSON 会漏进预览
      if (type === 'tx.completed') return '交易已完成'
    }
  } catch {
    // 不是 JSON：按普通文本渲染
  }
  return last.content
}

/**
 * 1版稿名字右侧的状态胶囊配色：待面交=橙，已完成/已取消=灰，其余品牌色。
 * 系统会话在列表里不显示胶囊（1版稿「鱼小应小助手」行只有名字）。
 */
function statusVariant(item: MockConversation): 'warn' | 'done' | null {
  if (item.tag === '待面交') return 'warn'
  if (item.tagDone) return 'done'
  return null
}

export default function Chat() {
  // 消息列表需要登录（GET /conversations）；Tab 页只能用 navigateTo 跳登录页
  const authStatus = useAuthGuard({ tab: true })
  const [items, setItems] = useState<MockConversation[]>([])
  const [filter, setFilter] = useState<ConversationFilter>('all')
  /** 本地已读：「全部已读」后把这些会话的未读角标清零（不写回 mock） */
  const [readIds, setReadIds] = useState<string[]>([])
  const [showTop, setShowTop] = useState(false)

  useLoad(() => {
    // 数据是本地 mock（同步），保留 state 是为了将来换成真接口时页面结构不用改
    setItems(conversations())
  })

  /** 1版稿 .totop：滚过一屏半后浮现 */
  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > TOTOP_THRESHOLD))

  /** #23：通知页的未读数（独立端点 `GET /notifications/unread-count` 的语义） */
  const unreadNotifications = unreadNotificationCount()

  /** 已读处理后的会话：计数、筛选、角标都只看这一份，避免三处各算一遍 */
  const shown = useMemo(
    () => items.map((item) => (readIds.includes(item.id) ? { ...item, unreadCount: 0 } : item)),
    [items, readIds],
  )
  const counts = useMemo(() => countByFilter(shown), [shown])
  const visible = useMemo(() => filterConversations(shown, filter), [shown, filter])

  const markAllRead = () => {
    if (counts.unread === 0) {
      void Taro.showToast({ title: '没有未读会话', icon: 'none' })
      return
    }
    setReadIds(items.map((item) => item.id))
    void Taro.showToast({ title: '已全部标为已读', icon: 'none' })
  }

  const openConversation = (id: string) => {
    void Taro.navigateTo({ url: `/pages/conversation/index?id=${id}` })
  }

  /**
   * 1版稿删掉了置顶「系统通知」行，通知页（#23）的入口由列表里的
   * 系统会话行（「鱼小应小助手」）兼作 —— 两者都是「平台发给你的消息」。
   */
  const openNotifications = () => {
    void Taro.navigateTo({ url: '/pages/notifications/index' })
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /**
   * 未登录 / 登录态还没恢复完之前**不渲染列表**。
   *
   * 守卫只负责跳转，跳转可能失败（页面栈、Tab 页限制），而且数据本身来自 mock ——
   * 不拦渲染的话，未登录用户会看到一串演示会话（`docs` 里的「未登录看到演示数据」）。
   */
  if (authStatus !== 'authed') {
    // `unknown`（冷启动的 `GET /me` 还没回来）不能说「登录后查看消息」——
    // 已登录用户会先看到一句与自己状态相反的文案（见 `guard.ts` 文件头第 1 条）
    return (
      <View className="chat">
        <View className="chat__bg" />
        <TopBar variant="glass" spacer title="消" titleEm="息" />
        {authStatus === 'unknown' ? (
          <View className="chat__empty">
            <Text className="chat__empty-title">正在恢复登录状态…</Text>
          </View>
        ) : (
          <View className="chat__empty">
            <Text className="chat__empty-title">登录后查看消息</Text>
            <Text className="chat__empty-text">和同学聊一聊、确认面交都在这里</Text>
          </View>
        )}
      </View>
    )
  }

  return (
    <View className="chat">
      <View className="chat__bg" />

      {/*
        吸顶玻璃栏：主行「消息」+ 副行筛选 Tab（1版稿 .filterbar）在同一块玻璃里，
        会话列表从底下滚过。「全部已读」小圆钮在副行右端 —— 食盒图标有两版：
        有未读走主题色，全部已读转灰。
      */}
      <TopBar
        variant="glass"
        spacer
        title="消"
        titleEm="息"
        below={
          <View className="chat__filters">
            <View className="chat__tabs">
              {FILTERS.map((item) => {
                const on = item.key === filter
                return (
                  <View
                    key={item.key}
                    // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child）
                    className={`chat__tab chat__tab--${item.key}${on ? ' is-on' : ''}`}
                    onClick={() => setFilter(item.key)}
                  >
                    <Text>{item.label}</Text>
                    {/* 1版稿只有「全部」带计数 */}
                    {item.key === 'all' && counts.all > 0 ? (
                      <Text className="chat__tab-n num">{counts.all}</Text>
                    ) : null}
                  </View>
                )
              })}
            </View>

            <View className="chat__readall" onClick={markAllRead}>
              <Image
                className="chat__readall-ic"
                src={counts.unread === 0 ? ICONS.readallMuted : ICONS.readallAccent}
                mode="aspectFit"
              />
            </View>
          </View>
        }
      />
      {/* 副行占位：筛选行高 28（上衬）+ 68（Tab 高）= 96px，组件的 spacer 只含主行 */}
      <View className="chat__header-gap" />

      {/*
        会话列表（1版稿 .list）。
        系统会话行即通知页入口（见 `openNotifications`）；它的角标挂的是
        通知未读数（#23），普通会话行挂自己的未读数。
      */}
      <View className="chat__list">
        {visible.map((item) => {
          const isSystem = item.kind === 'system'
          /** 直接消费契约 `ConversationDto.counterpart`，不再拿 id 自己查表 */
          const user = item.counterpart
          const name = isSystem ? SYSTEM_NAME : user.nickname
          const tick = !isSystem && user.authStatus === 'VERIFIED'
          const unread = item.unreadCount
          const variant = statusVariant(item)
          const badge = isSystem ? unreadNotifications : unread

          return (
            <View
              key={item.id}
              className={`chat__conv${unread > 0 ? ' is-unread' : ''}`}
              onClick={() => (isSystem ? openNotifications() : openConversation(item.id))}
            >
              {/* 头像 + 认证章 + 未读角标：要浮到头像外，所以裁剪只落在 .chat__ava 上 */}
              <View className="chat__ava-wrap">
                <View className={`chat__ava${isSystem ? ' chat__ava--sys' : ''}`}>
                  {isSystem ? (
                    <Image className="chat__ava-ic" src={ICONS.shieldWhite} mode="aspectFit" />
                  ) : (
                    // 契约允许 avatarUrl 为 null（users.avatar_url 可空）；空串即不渲染图
                    <Image className="chat__ava-img" src={user.avatarUrl ?? ''} mode="aspectFill" />
                  )}
                </View>
                {tick ? (
                  <View className="chat__cert">
                    <Image className="chat__cert-ic" src={ICONS.checkWhite} mode="aspectFit" />
                  </View>
                ) : null}
                {badge > 0 ? <Text className="chat__bdg num">{badge}</Text> : null}
              </View>

              <View className="chat__corp">
                <View className="chat__corp-top">
                  <Text className="chat__nm-tx">{name}</Text>
                  {item.tag && !isSystem ? (
                    <Text className={`chat__st${variant ? ` chat__st--${variant}` : ''}`}>
                      {item.tag}
                    </Text>
                  ) : null}
                </View>
                <Text className="chat__msg">{previewText(item)}</Text>
                {/* 1版稿时间在第三行（消息下方），不再是行右上角 */}
                <Text className="chat__tm num">{item.timeLabel}</Text>
              </View>

              {/* 右侧商品缩略图（1版稿 .thumb）：契约 `listing.coverUrl`，系统行走品牌渐变底 */}
              <View className={`chat__thumb${isSystem ? ' chat__thumb--brand' : ''}`}>
                {isSystem ? (
                  <Image className="chat__thumb-ic" src={ICONS.shieldWhite} mode="aspectFit" />
                ) : item.listing.coverUrl ? (
                  <Image
                    className="chat__thumb-img"
                    src={item.listing.coverUrl}
                    mode="aspectFill"
                  />
                ) : (
                  <Image className="chat__thumb-ic" src={ICONS.imageMuted} mode="aspectFit" />
                )}
              </View>
            </View>
          )
        })}

        {visible.length === 0 ? (
          <View className="chat__empty">
            <Text className="chat__empty-title">这里还没有会话</Text>
            <Text className="chat__empty-text">换个筛选看看其他消息</Text>
          </View>
        ) : null}
      </View>

      {/* 1版稿 .totop：滚过一屏半浮现，品牌色上箭头 */}
      <View className={`chat__totop${showTop ? ' is-show' : ''}`} onClick={backToTop}>
        <View className="chat__totop-arrow" />
      </View>
    </View>
  )
}
