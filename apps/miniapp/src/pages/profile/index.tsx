import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo } from 'react'
import brandLogo from '@/assets/brand/logo.png'
import { ICONS } from '@/assets/lib-icons'
import { formatAmount, ME, myListings, myWishes, profileStats } from '@/mock/api'
import './index.scss'

/**
 * 「我的」Tab。**设计稿没有覆盖这一屏**，按 `DESIGN.md` 的令牌与布局语言自绘：
 * 个人卡（头像/昵称/认证/校区）→ 数据行（在售/愿望/成交/信用）→ 我的发布 → 我的愿望
 * → 功能入口（收藏 / 足迹 / 买卖 / 设置）→ 版权行。
 *
 * 数据来自 mock：`ME` / `myListings()` / `myWishes()` / `profileStats()`，
 * 字段对齐 `profile/schema.ts` 的 `profileResponseSchema`（user / stats / listings / wishes）。
 */
const ENTRIES = [
  { key: 'favorites', label: '我的收藏', icon: ICONS.heartMuted, note: '12 件' },
  { key: 'history', label: '浏览足迹', icon: ICONS.historyMuted, note: '本周 36 次' },
  { key: 'orders', label: '我的买卖', icon: ICONS.orderMuted, note: '待确认 1' },
  { key: 'settings', label: '设置', icon: ICONS.settingsMuted, note: '' },
]

export default function Profile() {
  const stats = useMemo(() => profileStats(), [])
  const listings = useMemo(() => myListings(), [])
  const wishes = useMemo(() => myWishes(), [])

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  return (
    <View className="profile">
      <View className="profile__hero-bg" />

      <View className="profile__body">
        <View className="profile__card">
          <View className="profile__identity">
            <Image className="profile__avatar" src={ME.avatarUrl} mode="aspectFill" />
            <View className="profile__meta">
              <View className="profile__name-row">
                <Text className="profile__name">{ME.nickname}</Text>
                {ME.authStatus === 'VERIFIED' ? (
                  <Image className="profile__tick" src={ICONS.safeAccent} mode="aspectFit" />
                ) : null}
              </View>
            </View>
            {/* 「编辑」是圆形图标钮，绝对定位在卡片右上：文字版放不下（卡片内宽 251，头像+间距+昵称+勾已占满） */}
            <View className="profile__edit" onClick={() => toast('编辑资料待接入')}>
              <Image className="profile__edit-img" src={ICONS.settingsMuted} mode="aspectFit" />
            </View>
          </View>

          <Text className="profile__campus">
            {`${ME.campus ?? '未知'}校区 · ${ME.authStatus === 'VERIFIED' ? '已认证' : '待认证'}`}
          </Text>

          <View className="profile__stats">
            <View className="profile__stat">
              <Text className="profile__stat-num">{stats.activeListings}</Text>
              <Text className="profile__stat-label">在售</Text>
            </View>
            <View className="profile__stat">
              <Text className="profile__stat-num">{stats.activeWishes}</Text>
              <Text className="profile__stat-label">愿望</Text>
            </View>
            <View className="profile__stat">
              <Text className="profile__stat-num">{stats.completedTransactions}</Text>
              <Text className="profile__stat-label">成交</Text>
            </View>
            <View className="profile__stat">
              <Text className="profile__stat-num">{myListings().length}</Text>
              <Text className="profile__stat-label">发布</Text>
            </View>
          </View>
        </View>

        <View className="profile__sec">
          <Text className="profile__sec-title">我的发布</Text>
          <Text className="profile__sec-note" onClick={() => toast('发布管理待接入')}>
            {`共 ${listings.length} 件`}
          </Text>
        </View>
        <View className="profile__list">
          {listings.slice(0, 3).map((listing) => (
            <View
              key={listing.id}
              className="profile__row"
              onClick={() =>
                void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
              }
            >
              <Image className="profile__row-thumb" src={listing.coverUrl} mode="aspectFill" />
              <View className="profile__row-main">
                <Text className="profile__row-title">{listing.title}</Text>
                <View className="profile__row-meta">
                  <Text className="profile__row-price">{`¥${formatAmount(listing.priceCents)}`}</Text>
                  <Text className="profile__row-dot">·</Text>
                  <Text className="profile__row-sub">{`${listing.views} 浏览 · ${listing.wants} 想要`}</Text>
                  <Text className="profile__row-state">
                    {listing.status === 'ACTIVE' ? '在售' : '已下架'}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        <View className="profile__sec">
          <Text className="profile__sec-title">我的愿望</Text>
          <Text
            className="profile__sec-note"
            onClick={() => void Taro.switchTab({ url: '/pages/wish/index' })}
          >
            {`共 ${wishes.length} 条`}
          </Text>
        </View>
        <View className="profile__list">
          {wishes.slice(0, 2).map((wish) => (
            <View key={wish.id} className="profile__row" onClick={() => toast('愿望详情待接入')}>
              <View className="profile__row-mark">
                <Image className="profile__row-mark-img" src={ICONS.book} mode="aspectFit" />
              </View>
              <View className="profile__row-main">
                <Text className="profile__row-title">{wish.keyword}</Text>
                <View className="profile__row-meta">
                  <Text className="profile__row-price">
                    {`¥${formatAmount(wish.budgetMinCents)}–${formatAmount(wish.budgetMaxCents)}`}
                  </Text>
                  <Text className="profile__row-dot">·</Text>
                  <Text className="profile__row-sub">{`${wish.timeLabel} · ${wish.campus}校区`}</Text>
                  <Text className={`profile__row-state${wish.matchCount > 0 ? ' is-hit' : ''}`}>
                    {wish.matchCount > 0 ? `${wish.matchCount} 个匹配` : '等待匹配'}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        <View className="profile__entries">
          {ENTRIES.map((entry) => (
            <View
              key={entry.key}
              className="profile__entry"
              onClick={() => toast(`${entry.label}待接入`)}
            >
              <Image className="profile__entry-icon" src={entry.icon} mode="aspectFit" />
              <Text className="profile__entry-label">{entry.label}</Text>
              <Text className="profile__entry-note">{entry.note}</Text>
              <Image
                className="profile__entry-arrow"
                src={ICONS.chevronRightMuted}
                mode="aspectFit"
              />
            </View>
          ))}
        </View>

        <View className="profile__footer">
          <Image className="profile__footer-logo" src={brandLogo} mode="aspectFit" />
          <Text className="profile__footer-copy">©2026 鱼小应，版权所有</Text>
        </View>
      </View>
    </View>
  )
}
