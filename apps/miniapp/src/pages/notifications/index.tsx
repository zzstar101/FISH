import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import NavBar from '@/components/nav-bar'
import { findListing, type MockNotification, notifications } from '@/mock/api'
import './index.scss'

/** 「全部已读」动作钮的图标（导航栏右侧） */
const MARK_ALL_ICON = ICONS.checkMuted

/** 按 kind 取图标：许愿命中 / 商品留言 / 交易进度 / 系统通知 */
const KIND_ICON: Record<MockNotification['kind'], string> = {
  wish_match: ICONS.heartOn,
  listing_comment: ICONS.commentMuted,
  transaction: ICONS.orderMuted,
  system: ICONS.safeAccent,
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

  useLoad(() => {
    setItems(notifications())
  })

  const unread = items.filter((item) => !item.read).length

  const markAllRead = () => {
    if (unread === 0) {
      void Taro.showToast({ title: '没有未读通知', icon: 'none' })
      return
    }
    setItems((prev) => prev.map((item) => ({ ...item, read: true })))
    void Taro.showToast({ title: '已全部标为已读', icon: 'none' })
  }

  /** 点条目：先本地置读，再按 payload 跳转；既没有 listingId 也没有 wishId 时只标记已读 */
  const open = (item: MockNotification) => {
    setItems((prev) => prev.map((one) => (one.id === item.id ? { ...one, read: true } : one)))

    const listing = item.listingId ? findListing(item.listingId) : undefined
    if (listing) {
      void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
      return
    }
    if (item.wishId) {
      void Taro.switchTab({ url: '/pages/wish/index' })
      return
    }
    if (!item.read) void Taro.showToast({ title: '已标为已读', icon: 'none' })
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
            className={`notif__item${item.read ? '' : ' is-unread'}`}
            onClick={() => open(item)}
          >
            <View className="notif__ic">
              <Image className="notif__ic-img" src={KIND_ICON[item.kind]} mode="aspectFit" />
            </View>

            <View className="notif__body">
              <Text className="notif__body-title">{item.title}</Text>
              <View className="notif__meta">
                {item.read ? null : <View className="notif__dot" />}
                <Text className="notif__tm num">{relativeTime(item.createdAt)}</Text>
              </View>
              <Text className="notif__text">{item.body}</Text>
            </View>
          </View>
        ))}

        {items.length === 0 ? (
          <EmptyState
            title="还没有通知"
            text="许愿命中、商品留言与交易进度都会送到这里"
            icon={ICONS.bellInk}
          />
        ) : null}
      </View>
    </View>
  )
}
