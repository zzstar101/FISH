import type { ProfileStats } from '@fish/contracts/profile/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'
import brandLogo from '@/assets/brand/logo.png'
import { ICONS } from '@/assets/lib-icons'
import { useAuth } from '@/features/auth/store'
import { loadProfile, type ProfileView } from '@/features/fetchers'
import { readNavMetrics } from '@/lib/nav-metrics'
import { APP_VERSION, formatAmount } from '@/mock/api'
import './index.scss'

/**
 * 「我的」页的完整数据默认值。
 *
 * 拿不到 `GET /profile` 时用 0 而不是 mock 的演示数字：宁可显示 0 或空，
 * 也不把别人的数据摆在当前用户的名字下面。
 */
const EMPTY_STATS: ProfileStats = {
  activeListings: 0,
  activeWishes: 0,
  completedTransactions: 0,
}

/**
 * 「我的」Tab。**设计稿没有覆盖这一屏**，按 `DESIGN.md` 的令牌与布局语言自绘：
 * 个人卡（头像/昵称/认证/校区）→ 数据行（在售/愿望/成交/发布）→ 我的发布 → 我的愿望
 * → 功能入口 → 版权行。
 *
 * 数据走 `features/fetchers.ts` 的 `loadProfile()`，字段对齐 `profile/schema.ts` 的
 * `profileResponseSchema`（user / stats / listings / wishes）。
 *
 * **登录态（本次改动）**：
 * - 未登录 → 只渲染登录引导卡 + 通用入口，不渲染任何账号数据；
 * - 登录态未就绪（`unknown`）→ 只渲染占位，不拿 mock 顶上；
 * - 已登录 → 身份来自 `GET /profile`（拿不到时退 `authUser`），业务数据**只认真实值**，
 *   取不到就按空渲染（`EMPTY_STATS` / `[]`）——不再回退 mock，mock 属于演示账号。
 *
 * **入口接线**（既有结构不变，只把入口挂到真实页面）：
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
  const [profile, setProfile] = useState<ProfileView | null>(null)

  /**
   * 顶部留白。
   *
   * 设计稿（`小程序1版profile.html`）本页的标题是 `sr-only`（只有屏幕阅读器可见），
   * 顶栏里**没有任何可视 UI** —— 所以不挂 `top-bar`，只按同一套胶囊栅格把内容顶下去，
   * 否则个人卡会压到刘海与原生胶囊上。数值来源与 `top-bar` 一致（`@/lib/nav-metrics`）。
   */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  const { status: authStatus, user: authUser } = useAuth()
  /** 只有**确定**未登录才显示登录引导（`unknown` = 冷启动 `GET /me` 还没回来） */
  const anonymous = authStatus === 'anonymous'

  /**
   * 拿到真实登录态后才打 `GET /profile`。
   *
   * 依赖 `authUser?.id` 而不是只有 `authStatus`：换账号是 `authed → authed`，
   * 只看状态不会重拉，页面上会短暂留着上一个账号的数据。退出 / 会话失效时
   * 顺手清空，避免同一类串号窗口。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !authUser) {
      setProfile(null)
      return
    }
    const forUserId = authUser.id
    void loadProfile().then((next) => {
      // 换账号 / 退出期间回来的旧响应不能写进当前页面（否则短暂串号）
      if (next && next.user.id !== forUserId) return
      setProfile(next)
    })
  }, [authStatus, authUser])

  /**
   * 只使用**真实数据**，不再回退 mock。
   *
   * mock 的业务数据属于演示账号「阿岚」：一旦与真实登录身份拼在同一屏，就会出现
   * 「真实昵称 + 别人的在售数与愿望」。`GET /profile` 没回来或失败时各区块按空值渲染。
   *
   * 已知取舍：本页是 Tab 页，切走再切回不会重新挂载，所以「发布 / 成交之后回到我的」
   * 看到的是上次拉取的计数，要等登录态变化或重进小程序才刷新（要更实时就得加
   * `useDidShow` 重拉，属于后续改动）。
   */
  const user = profile?.user ?? authUser
  const stats = profile?.stats ?? EMPTY_STATS
  const listings = profile?.listings ?? []
  const wishes = profile?.wishes ?? []
  /** 待面交笔数：真实数据由 loadProfile 从 transactions 里 PENDING_MEETUP 折算而来 */
  const pendingMeetup = profile?.pendingMeetup ?? 0
  const orderCount = profile?.orderCount ?? 0

  const verified = user?.authStatus === 'VERIFIED'

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

  /**
   * 账号相关的计数（在售件数 / 待面交 / 认证状态）只在拿到真实 `profile` 时才显示。
   * 拿不到就不显示，而不是回退 mock —— 那是演示账号的数字。
   */
  const own = (text: string) => (profile === null ? '' : text)

  const ENTRIES: Entry[] = [
    // 收藏与足迹**没有数据源**（既无页面也无端点），所以 note 留空 ——
    // 之前写死的「12 件」「本周 36 次」在本页已接真实数据后就是编造的数字。
    { key: 'favorites', label: '我的收藏', icon: ICONS.heartMuted, note: '' },
    { key: 'history', label: '浏览足迹', icon: ICONS.historyMuted, note: '' },
    {
      key: 'mylist',
      label: '我的发布',
      icon: ICONS.box,
      note: own(`${listings.length} 件`),
      url: '/pages/mylist/index',
    },
    {
      key: 'orders',
      label: '我的买卖',
      icon: ICONS.orderMuted,
      note: own(pendingMeetup > 0 ? `待面交 ${pendingMeetup}` : `${orderCount} 笔`),
      url: '/pages/orders/index',
    },
    {
      key: 'verify',
      label: '校园认证',
      icon: ICONS.safeAccent,
      note: own(verified ? '已认证' : '去认证'),
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

  /** 通用尾部（功能入口 + 版权行）：登录与未登录两种形态共用一份 */
  const tail = (
    <>
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
    </>
  )

  /**
   * 未登录：只给登录引导 + 通用入口。
   *
   * 不渲染「数据行 / 我的发布 / 我的愿望」——未登录时那些数据只能来自 mock，
   * 等于把演示账号的商品与愿望摆给一个没登录的人看。
   */
  if (anonymous) {
    return (
      <View className="profile">
        <View className="profile__hero-bg" />
        <View className="profile__body" style={{ paddingTop: `${navHeight + 8}px` }}>
          <View className="profile__card profile__guest">
            <View className="profile__guest-av">
              <Image className="profile__guest-ic" src={ICONS.user} mode="aspectFit" />
            </View>
            <Text className="profile__guest-title">你还没有登录</Text>
            <Text className="profile__guest-text">
              登录后可以发布闲置、发起交易、查看消息与订单。
            </Text>
            <View
              className="profile__guest-btn"
              onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}
            >
              <Text>登录 / 注册</Text>
            </View>
          </View>
          {tail}
        </View>
      </View>
    )
  }

  /**
   * 本地有会话、但 `GET /me` 还没回来：给一个最小占位。
   *
   * 不能落到下面的「已登录」布局 —— 那一层的身份在 `authUser` 为空时会退回
   * mock 的演示账号「阿岚」，等于把一个陌生人显示成当前用户。等 store 广播后再渲染。
   */
  if (authStatus === 'unknown') {
    return (
      <View className="profile">
        <View className="profile__hero-bg" />
        <View className="profile__body" style={{ paddingTop: `${navHeight + 8}px` }}>
          <View className="profile__card profile__guest">
            <Text className="profile__guest-text">正在恢复登录状态…</Text>
          </View>
        </View>
      </View>
    )
  }

  // 到这一步 `status === 'authed'`（anonymous / unknown 已在上面两个分支返回），
  // `authUser` 必然存在；这里只把类型收窄，并给「已登录但 /me 抖动」兜个底。
  if (!user) return null

  return (
    <View className="profile">
      <View className="profile__hero-bg" />

      <View className="profile__body" style={{ paddingTop: `${navHeight + 8}px` }}>
        <View className="profile__card">
          <View className="profile__identity">
            {/* 契约 `MeSchema.avatarUrl` 可为 null：空串即不渲染图，不拿别人的头像顶上 */}
            <Image className="profile__avatar" src={user.avatarUrl ?? ''} mode="aspectFill" />
            <View className="profile__meta">
              <View className="profile__name-row">
                <Text className="profile__name">{user.nickname}</Text>
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
              {`${user.campus ?? '未知'}校区 · ${verified ? '已认证' : '待认证'}`}
            </Text>
            <Image
              className="profile__campus-arrow"
              src={ICONS.chevronRightMuted}
              mode="aspectFit"
            />
          </View>

          {/* 数据行：在售 → 我的发布；成交 → 我的买卖；愿望 → 许愿 Tab。
              只在拿到真实 profile 时渲染：拿不到就不显示，不回退 mock */}
          {profile ? (
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
          ) : null}
        </View>

        {/* 我的发布 / 我的愿望：同样只在有真实数据时渲染 */}
        {profile ? (
          <>
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
                      {/* 契约没有浏览/想要计数：真实数据下为 null，连前缀的「·」一起不画，不留孤立分隔符 */}
                      {listing.views === null ? null : (
                        <>
                          <Text className="profile__row-dot">·</Text>
                          <Text className="profile__row-sub">{`${listing.views} 浏览`}</Text>
                        </>
                      )}
                      {/* 「N 人想要」是 C5 的入口，带上是哪件商品；计数缺失时入口本身也不该存在 */}
                      {listing.wants === null ? null : (
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
                      )}
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
                        {/* 校区契约里可为 null（WishDto 无校区字段）：缺了就只显示时间，
                        不拼出「null校区」 */}
                        <Text className="profile__row-sub">
                          {wish.campus ? `${wish.timeLabel} · ${wish.campus}校区` : wish.timeLabel}
                        </Text>
                        <Text className={`profile__row-state${hit ? ' is-hit' : ''}`}>
                          {hit ? `${wish.matchCount} 个匹配 ›` : '等待匹配'}
                        </Text>
                      </View>
                    </View>
                  </View>
                )
              })}
            </View>
          </>
        ) : null}

        {tail}
      </View>
    </View>
  )
}
