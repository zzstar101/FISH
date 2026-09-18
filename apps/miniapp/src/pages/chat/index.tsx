import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import {
  type ConversationFilter,
  chatSummary,
  conversations,
  countByFilter,
  filterConversations,
  formatAmount,
  type MockConversation,
  unreadNotificationCount,
} from '@/mock/api'
import './index.scss'

/** 筛选胶囊（设计稿顺序：全部 / 未读 / 交易 / 许愿 / 系统） */
const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'deal', label: '交易' },
  { key: 'wish', label: '许愿' },
  { key: 'system', label: '系统' },
]

/**
 * 系统会话（`kind === 'system'`）的展示名。
 *
 * mock 里这条会话的 `counterpartId` 是当前用户自己（`u-alan`），因为系统通知本来就没有
 * 「对方」；设计稿这一行写的是「鱼小应小助手」，所以这里按会话类型覆盖昵称。
 */
const SYSTEM_NAME = '鱼小应小助手'

/** 胶囊上的计数：设计稿只有「全部 / 未读」带数字，其余三个不带 */
function chipCount(key: ConversationFilter, counts: { all: number; unread: number }): string {
  if (key === 'all') return String(counts.all)
  if (key === 'unread') return String(counts.unread)
  return ''
}

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
    }
  } catch {
    // 不是 JSON：按普通文本渲染
  }
  return last.content
}

export default function Chat() {
  // 消息列表需要登录（GET /conversations）；Tab 页只能用 navigateTo 跳登录页
  const authStatus = useAuthGuard({ tab: true })
  const [items, setItems] = useState<MockConversation[]>([])
  const [filter, setFilter] = useState<ConversationFilter>('all')
  /** 本地已读：「全部已读」后把这些会话的未读角标清零（不写回 mock） */
  const [readIds, setReadIds] = useState<string[]>([])

  useLoad(() => {
    // 数据是本地 mock（同步），保留 state 是为了将来换成真接口时页面结构不用改
    setItems(conversations())
  })

  const summary = chatSummary()

  /** #23：置顶「系统通知」行的未读数（独立端点 `GET /notifications/unread-count` 的语义） */
  const unreadNotifications = unreadNotificationCount()

  const openNotifications = () => {
    void Taro.navigateTo({ url: '/pages/notifications/index' })
  }

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
        <TopBar variant="plain" spacer title="消" titleEm="息" />
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
        固定顶栏：一级标题「消息」钉在顶部，右侧「全部已读」。
        设计稿里「息」走品牌色（`.mp-title .c-brand`），由 `titleEm` 表达。
      */}
      <TopBar
        variant="plain"
        spacer
        title="消"
        titleEm="息"
        actions={
          <View className="chat__act" onClick={markAllRead}>
            {/* 设计稿是「双勾」；图标库里没有双勾语义，取最接近的单勾 checkMuted */}
            <Image className="chat__act-ic" src={ICONS.checkMuted} mode="aspectFit" />
            <Text className="chat__act-tx">全部已读</Text>
          </View>
        }
      />

      {/*
        待回复 / 待确认面交的汇总行。
        原先是页头里的副标题，标题抬进顶栏后它作为内容留在下面 —— 这是真实数据
        （`chatSummary()`），不跟着版式一起删。
      */}
      <View className="chat__lead">
        <Text className="chat__lead-tx">
          {`${summary.pendingReply} 条待回复 · ${summary.pendingMeetup} 笔待确认面交`}
        </Text>
      </View>

      <View className="chat__bento">
        <View
          className="chat__bcard chat__bcard--tint"
          onClick={() => void Taro.switchTab({ url: '/pages/wish/index' })}
        >
          <View className="chat__bic">
            <Image className="chat__bic-img" src={ICONS.starLine} mode="aspectFit" />
          </View>
          <Text className="chat__btt">许愿命中</Text>
          <Text className="chat__bsub">{`${summary.wishHit} 条心愿有了回应`}</Text>
          <View className="chat__bfoot">
            <Text>去查看</Text>
            <Text className="chat__bfoot-b">→</Text>
          </View>
        </View>

        <View className="chat__bcard chat__bcard--dark" onClick={() => setFilter('deal')}>
          <View className="chat__bic">
            <Image className="chat__bic-img chat__ic-white" src={ICONS.order} mode="aspectFit" />
          </View>
          <Text className="chat__btt">交易助手</Text>
          <Text className="chat__bsub">订单进度与面交提醒</Text>
          <View className="chat__bfoot">
            <Text>待确认</Text>
            <Text className="chat__bfoot-b">{summary.pendingMeetup}</Text>
          </View>
        </View>
      </View>

      <ScrollView className="chat__chips" scrollX enableFlex>
        <View className="chat__chips-inner">
          {FILTERS.map((item) => {
            const on = item.key === filter
            const count = chipCount(item.key, counts)
            return (
              <View
                key={item.key}
                className={`chat__chip${on ? ' is-on' : ''}`}
                onClick={() => setFilter(item.key)}
              >
                <Text>{item.label}</Text>
                {count ? <Text className="chat__chip-n">{count}</Text> : null}
              </View>
            )
          })}
        </View>
      </ScrollView>

      <View className="chat__sec">
        <Text className="chat__sec-title">最近联系</Text>
        <Text className="chat__sec-note">按时间排序</Text>
      </View>

      {/*
        #23 的入口形态（2026-09-12 决定）：「消息」tab 顶部置顶一行「系统通知」+ 未读红点，
        点击进入通知列表页。与 web 端 `features/chat/message-page.tsx` 同一形态，
        不复刻一份会话列表 —— 它只是本页列表区最上面的一行。
      */}
      <View className="chat__conv chat__conv--pin" onClick={openNotifications}>
        <View className="chat__ava-wrap">
          <View className="chat__ava chat__ava--sys">
            <Image
              className="chat__ava-ic chat__ic-white"
              src={ICONS.safeAccent}
              mode="aspectFit"
            />
          </View>
          {unreadNotifications > 0 ? (
            <Text className="chat__bdg num">{unreadNotifications}</Text>
          ) : null}
        </View>

        <View className="chat__corp">
          <View className="chat__corp-top">
            <View className="chat__nm">
              <Text className="chat__nm-tx">系统通知</Text>
            </View>
            <Text className="chat__tm num">全部</Text>
          </View>
          <View className="chat__corp-sub">
            <Text className="chat__msg">
              {unreadNotifications > 0 ? `${unreadNotifications} 条未读` : '暂无未读通知'}
            </Text>
            <Text className="chat__tag">通知</Text>
          </View>
        </View>
      </View>

      <View className="chat__list">
        {visible.map((item) => {
          const isSystem = item.kind === 'system'
          /** 直接消费契约 `ConversationDto.counterpart`，不再拿 id 自己查表 */
          const user = item.counterpart
          const name = isSystem ? SYSTEM_NAME : user.nickname
          const tick = !isSystem && user.authStatus === 'VERIFIED'
          const unread = item.unreadCount

          return (
            <View
              key={item.id}
              className={`chat__conv${unread > 0 ? ' is-unread' : ''}`}
              onClick={() => openConversation(item.id)}
            >
              {/* 头像 + 在线绿点 + 未读角标：角标要浮到头像外，所以裁剪只落在 .chat__ava 上 */}
              <View className="chat__ava-wrap">
                <View className={`chat__ava${isSystem ? ' chat__ava--sys' : ''}`}>
                  {isSystem ? (
                    <Image
                      className="chat__ava-ic chat__ic-white"
                      src={ICONS.safeAccent}
                      mode="aspectFit"
                    />
                  ) : (
                    // 契约允许 avatarUrl 为 null（users.avatar_url 可空）；空串即不渲染图
                    <Image className="chat__ava-img" src={user.avatarUrl ?? ''} mode="aspectFill" />
                  )}
                </View>
                {item.online && !isSystem ? <View className="chat__on" /> : null}
                {unread > 0 ? <Text className="chat__bdg num">{unread}</Text> : null}
              </View>

              <View className="chat__corp">
                <View className="chat__corp-top">
                  <View className="chat__nm">
                    <Text className="chat__nm-tx">{name}</Text>
                    {tick ? (
                      <Image className="chat__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
                    ) : null}
                  </View>
                  <Text className="chat__tm num">{item.timeLabel}</Text>
                </View>

                <View className="chat__corp-sub">
                  <Text className="chat__msg">{previewText(item)}</Text>
                  <Text className={`chat__tag${item.tagDone ? ' chat__tag--done' : ''}`}>
                    {item.tag}
                  </Text>
                </View>
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
    </View>
  )
}
