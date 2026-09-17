import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo } from 'react'
import brandLogo from '@/assets/brand/logo.png'
import { ICONS } from '@/assets/lib-icons'
import { readNavMetrics } from '@/lib/nav-metrics'
import {
  APP_VERSION,
  formatAmount,
  ME,
  myListings,
  myWishes,
  orderOverview,
  profileStats,
} from '@/mock/api'
import './index.scss'

/**
 * 「我的」Tab。**设计稿没有覆盖这一屏**，按 `DESIGN.md` 的令牌与布局语言自绘：
 * 个人卡（头像/昵称/认证/校区）→ 数据行（在售/愿望/成交/发布）→ 我的发布 → 我的愿望
 * → 功能入口 → 版权行。
 *
 * 数据来自 mock：`ME` / `myListings()` / `myWishes()` / `profileStats()` / `orderOverview()`，
 * 字段对齐 `profile/schema.ts` 的 `profileResponseSchema`（user / stats / listings / wishes）。
 *
 * **本轮的入口接线**（既有结构不变，只把入口挂到真实页面）：
 * - 个人卡的数据行：`在售` → 我的发布、`成交` → 我的买卖；`认证状态` → 校园认证。
 * - 「我的发布」标题右侧的 `共 N 件` → 我的发布；行内 `N 人想要` → 想要的人（带 listingId）。
 * - 「我的愿望」的命中项 → 匹配结果（带 wishId）。
 * - 功能入口区补齐：校园认证 / 我的发布 / 我的买卖 / 扫码 / 分类浏览 / 设置。
 *
 * 收藏与足迹**没有对应页面**（不在本次 14 页范围内），仍保持 toast 占位——不是漏接，
 * 而是没有目标页可跳，假装跳转会得到空白页。
 */

type Entry = {
  key: string
  label: string
  icon: string
  note: string
  /** 有 url 就跳转，没有就按 toast 处理（用于尚未落地的页面） */
  url?: string
  tab?: boolean
}

export default function Profile() {
  const stats = useMemo(() => profileStats(), [])
  const listings = useMemo(() => myListings(), [])
  const wishes = useMemo(() => myWishes(), [])
  const orders = useMemo(() => orderOverview(), [])

  /**
   * 顶部留白。
   *
   * 设计稿（`小程序1版profile.html`）本页的标题是 `sr-only`（只有屏幕阅读器可见），
   * 顶栏里**没有任何可视 UI** —— 所以不挂 `top-bar`，只按同一套胶囊栅格把内容顶下去，
   * 否则个人卡会压到刘海与原生胶囊上。数值来源与 `top-bar` 一致（`@/lib/nav-metrics`）。
   */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  const verified = ME.authStatus === 'VERIFIED'
  const pendingMeetup = orders.pending

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  const go = (entry: Entry) => {
    if (!entry.url) {
      toast(`${entry.label}待接入`)
      return
    }
    if (entry.tab) {
      void Taro.switchTab({ url: entry.url })
      return
    }
    void Taro.navigateTo({ url: entry.url })
  }

  const ENTRIES: Entry[] = [
    { key: 'favorites', label: '我的收藏', icon: ICONS.heartMuted, note: '12 件' },
    { key: 'history', label: '浏览足迹', icon: ICONS.historyMuted, note: '本周 36 次' },
    {
      key: 'mylist',
      label: '我的发布',
      icon: ICONS.box,
      note: `${listings.length} 件`,
      url: '/pages/mylist/index',
    },
    {
      key: 'orders',
      label: '我的买卖',
      icon: ICONS.orderMuted,
      note: pendingMeetup > 0 ? `待面交 ${pendingMeetup}` : `${orders.all} 笔`,
      url: '/pages/orders/index',
    },
    {
      key: 'verify',
      label: '校园认证',
      icon: ICONS.safeAccent,
      note: verified ? '已认证' : '去认证',
      url: '/pages/verify/index',
    },
    {
      key: 'category',
      label: '分类浏览',
      icon: ICONS.category,
      note: '',
      url: '/pages/category/index',
    },
    {
      key: 'scan',
      label: '扫码',
      icon: ICONS.scan,
      note: '面交核对交易码',
      url: '/pages/scan/index',
    },
    {
      key: 'settings',
      label: '设置',
      icon: ICONS.settingsMuted,
      note: `v${APP_VERSION}`,
      url: '/pages/settings/index',
    },
  ]

  /** 认证状态标记：已认证进认证页看状态，未认证去认证（同一条路由，文案不同） */
  const openVerify = () => void Taro.navigateTo({ url: '/pages/verify/index' })

  return (
    <View className="profile">
      <View className="profile__hero-bg" />

      <View className="profile__body" style={{ paddingTop: `${navHeight + 8}px` }}>
        <View className="profile__card">
          <View className="profile__identity">
            <Image className="profile__avatar" src={ME.avatarUrl} mode="aspectFill" />
            <View className="profile__meta">
              <View className="profile__name-row">
                <Text className="profile__name">{ME.nickname}</Text>
                {verified ? (
                  <Image className="profile__tick" src={ICONS.safeAccent} mode="aspectFit" />
                ) : null}
              </View>
            </View>
            {/* 「编辑」是圆形图标钮，绝对定位在卡片右上：文字版放不下（卡片内宽 251，头像+间距+昵称+勾已占满） */}
            <View className="profile__edit" onClick={() => toast('编辑资料待接入')}>
              <Image className="profile__edit-img" src={ICONS.settingsMuted} mode="aspectFit" />
            </View>
          </View>

          {/* 认证状态本身就是入口：点它进校园认证页 */}
          <View className="profile__campus-row" onClick={openVerify}>
            <Text className="profile__campus">
              {`${ME.campus ?? '未知'}校区 · ${verified ? '已认证' : '待认证'}`}
            </Text>
            <Image
              className="profile__campus-arrow"
              src={ICONS.chevronRightMuted}
              mode="aspectFit"
            />
          </View>

          {/* 数据行：在售 → 我的发布；成交 → 我的买卖；愿望 → 许愿 Tab */}
          <View className="profile__stats">
            <View
              className="profile__stat"
              onClick={() => void Taro.navigateTo({ url: '/pages/mylist/index' })}
            >
              <Text className="profile__stat-num">{stats.activeListings}</Text>
              <Text className="profile__stat-label">在售</Text>
            </View>
            <View
              className="profile__stat"
              onClick={() => void Taro.switchTab({ url: '/pages/wish/index' })}
            >
              <Text className="profile__stat-num">{stats.activeWishes}</Text>
              <Text className="profile__stat-label">愿望</Text>
            </View>
            <View
              className="profile__stat"
              onClick={() => void Taro.navigateTo({ url: '/pages/orders/index' })}
            >
              <Text className="profile__stat-num">{stats.completedTransactions}</Text>
              <Text className="profile__stat-label">成交</Text>
            </View>
            <View
              className="profile__stat"
              onClick={() => void Taro.navigateTo({ url: '/pages/mylist/index' })}
            >
              <Text className="profile__stat-num">{listings.length}</Text>
              <Text className="profile__stat-label">发布</Text>
            </View>
          </View>
        </View>

        <View className="profile__sec">
          <Text className="profile__sec-title">我的发布</Text>
          {/* 「共 N 件」进我的发布列表（本区只展示前 3 件） */}
          <Text
            className="profile__sec-note"
            onClick={() => void Taro.navigateTo({ url: '/pages/mylist/index' })}
          >
            {`共 ${listings.length} 件 ›`}
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
                  <Text className="profile__row-sub">{`${listing.views} 浏览`}</Text>
                  {/* 「N 人想要」是 C5 的入口，带上是哪件商品 */}
                  <Text
                    className="profile__row-state"
                    onClick={(event) => {
                      event.stopPropagation()
                      void Taro.navigateTo({
                        url: `/pages/watchers/index?listingId=${listing.id}&title=${encodeURIComponent(listing.title)}`,
                      })
                    }}
                  >
                    {`${listing.wants} 人想要 ›`}
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
          {wishes.slice(0, 2).map((wish) => {
            const hit = wish.matchCount > 0
            return (
              <View
                key={wish.id}
                className="profile__row"
                onClick={() =>
                  // 命中过的愿望进匹配结果页；没命中的回许愿墙（那才是能操作的地方）
                  void (hit
                    ? Taro.navigateTo({ url: `/pages/match/index?wishId=${wish.id}` })
                    : Taro.switchTab({ url: '/pages/wish/index' }))
                }
              >
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
                    <Text className={`profile__row-state${hit ? ' is-hit' : ''}`}>
                      {hit ? `${wish.matchCount} 个匹配 ›` : '等待匹配'}
                    </Text>
                  </View>
                </View>
              </View>
            )
          })}
        </View>

        <View className="profile__entries">
          {ENTRIES.map((entry) => (
            <View key={entry.key} className="profile__entry" onClick={() => go(entry)}>
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
