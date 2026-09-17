import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import NavBar from '@/components/nav-bar'
import { loadNotifications } from '@/features/fetchers'
import type { MockNotification } from '@/mock/api'
import './index.scss'

/** 「全部已读」动作钮的图标（导航栏右侧） */
const MARK_ALL_ICON = ICONS.checkMuted

/**
 * 语气 → 图标。文案与跳转目标**不在页面里拼**：契约只存 `type` + `payload`，
 * 组装在数据层（`mock/api.ts` 的 `decorateNotification`，与 web 端同口径）。
 * 所以这里只负责「把 tone 映射成一张图」这种纯展示的事。
 */
const TONE_ICON: Record<MockNotification['tone'], string> = {
  mint: ICONS.heartOn,
  warn: ICONS.safeAccent,
}

/**
 * 相对时间。fixture 的 `createdAt` 固定在 2026-09-14，因此这里以「现在」为基准算差值，
 * 而不是渲染 mock 里的绝对时间。
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const hours = Math.max(0, (Date.now() - then) / 3600000)
  if (hours < 1 / 60) return '刚刚'
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))} 分钟前`
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  const days = Math.floor(hours / 24)
  return days === 1 ? '昨天' : `${days} 天前`
}

export default function Notifications() {
  const [items, setItems] = useState<MockNotification[]>([])
  /**
   * 是否已经拿到一次结果。
   *
   * 没有它的话，`items` 初始为空数组会让「还没有通知」这个空态在请求返回前先闪一下 ——
   * 有通知的用户会看到一句假话。加载完成的判据是「这一次 promise 落了」，
   * 成功与回退都算（回退也返回一批可用数据）。
   */
  const [ready, setReady] = useState(false)

  useLoad(() => {
    // 文案与跳转目标由数据层组装（真实接口与 mock 走同一份 decorateNotification），
    // 页面只拿结果 —— 所以这里只把同步调用换成异步，渲染逻辑不动
    void loadNotifications()
      .then(setItems)
      .finally(() => setReady(true))
  })

  /** 未读的唯一判据是契约字段 `readAt === null` */
  const isUnread = (item: MockNotification) => item.readAt === null
  const unread = items.filter(isUnread).length

  const markAllRead = () => {
    if (unread === 0) {
      void Taro.showToast({ title: '没有未读通知', icon: 'none' })
      return
    }
    // 真实实现是 `POST /notifications/:id/read`（幂等）；这里按契约语义写本地 readAt
    setItems((prev) =>
      prev.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
    )
    void Taro.showToast({ title: '已全部标为已读', icon: 'none' })
  }

  /** 点条目：先本地置读，再按 `target` 跳转（目标缺失时只标记已读） */
  const open = (item: MockNotification) => {
    setItems((prev) =>
      prev.map((one) =>
        one.id === item.id ? { ...one, readAt: one.readAt ?? new Date().toISOString() } : one,
      ),
    )

    if (item.target?.kind === 'listing') {
      void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.target.listingId}` })
      return
    }
    if (item.target?.kind === 'wish') {
      void Taro.switchTab({ url: '/pages/wish/index' })
      return
    }
    if (isUnread(item)) void Taro.showToast({ title: '已标为已读', icon: 'none' })
  }

  return (
    <View className="notif">
      <View className="notif__bg" />

      <NavBar
        actions={
          <View className="notif__act" onClick={markAllRead}>
            <Image className="notif__act-ic" src={MARK_ALL_ICON} mode="aspectFit" />
            <Text className="notif__act-tx">全部已读</Text>
            {unread > 0 ? <View className="notif__act-dot" /> : null}
          </View>
        }
      />

      <View className="notif__hd">
        <Text className="notif__title">通知</Text>
        <Text className="notif__sub">
          {unread > 0
            ? `${unread} 条未读 · 共 ${items.length} 条`
            : `全部已读 · 共 ${items.length} 条`}
        </Text>
      </View>

      <View className="notif__list">
        {items.map((item) => (
          <View
            key={item.id}
            className={`notif__item${isUnread(item) ? ' is-unread' : ''}`}
            onClick={() => open(item)}
          >
            <View className="notif__ic">
              <Image className="notif__ic-img" src={TONE_ICON[item.tone]} mode="aspectFit" />
            </View>

            <View className="notif__body">
              <Text className="notif__body-title">{item.title}</Text>
              <View className="notif__meta">
                {isUnread(item) ? <View className="notif__dot" /> : null}
                <Text className="notif__tm num">{relativeTime(item.createdAt)}</Text>
              </View>
              <Text className="notif__text">{item.description}</Text>
            </View>
          </View>
        ))}

        {/* 空态只在「确实拿到过一次结果」之后才显示，避免请求途中闪过一句「还没有通知」 */}
        {ready && items.length === 0 ? (
          <EmptyState
            title="还没有通知"
            text="愿望匹配上闲置、交易有进展时会出现在这里"
            icon={ICONS.bellInk}
          />
        ) : null}
      </View>
    </View>
  )
}
