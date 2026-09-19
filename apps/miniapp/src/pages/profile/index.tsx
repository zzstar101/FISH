import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll } from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'
import brandLockup from '@/assets/brand/brand-lockup.png'
import { ICONS } from '@/assets/lib-icons'
import { clearLocalSession, revokeServerSession, useAuth } from '@/features/auth/store'
import { loadProfile, type ProfileView } from '@/features/fetchers'
import { cancellable } from '@/lib/cancellable'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 「我的」页，按 3版稿（`小程序3版profile.html`）+ Owner 的口头修订落地：
 * 个人头部（头像 / 昵称 + 认证胶囊 / 签名行 / 扫码）→ 三张**独立卡片**
 * （数字栏 4 格 → 图标栏 5 格 → 帮助与设置）→ 版权行。
 *
 * - **本页没有任何吸顶元素**：不挂 `top-bar`，顶部只按胶囊栅格留出初始空档；
 * - **头部没有「编辑」钮**：头像与昵称跟随微信直接获取，本页可编辑的只有个性签名；
 *   扫码钮与头像同一行对齐；
 * - 三张卡圆角 8pt、无边框描边，只有「帮助与设置」卡带底部阴影（Owner 指定）；
 * - 数字栏（收藏 / 历史浏览 / 关注 / 愿望）只摆数字不摆图标；
 *   图标栏改为**右上角红色小圆点、圆点内显数量**（纯 --danger，不要压棕的红）。
 *
 * 数据走 `features/fetchers.ts` 的 `loadProfile()`。数字栏与圆点只在拿到
 * `GET /profile` 后按真实值渲染，拿不到就显示 0 / 无圆点，不回退 mock
 * （演示构建的回退口径见 fetchers `loadProfile` 的 catch）。
 *
 * **已经 Owner 确认的取舍**：
 * - 签名行**默认出现**：契约的 `Me` 还没有个性签字段，先按稿渲染默认文案，
 *   等接口补了字段再换成真实签名；
 * - 「编辑个人资料」「隐私」两行不渲染：头像昵称跟随微信、隐私入口在设置页里；
 * - 稿里的「清除演示数据」行不渲染：本地没有任何演示数据存储可清。
 *
 * **退出登录**与设置页同一套两步走：先 `revokeServerSession()` 把服务端会话注销
 * （失败要告知，否则用户以为退了、会话其实还有效），再 `clearLocalSession()`
 * 广播 `anonymous`，本页随之切到未登录形态。
 */

/** 数字栏格子（3版稿 4 格栏改纯数字）。`count` 由 profile 提供，未拿到时按 0 显示 */
type StatCell = {
  key: string
  label: string
  url?: string
  tab?: boolean
  count: number
}

/** 图标栏格子（5 格）。`count` > 0 时在右上角显示红色数量圆点（纯 --danger） */
type IconCell = {
  key: string
  label: string
  icon: string
  url?: string
  tab?: boolean
  count?: number
}

/** 「帮助与设置」列表行。`url` 缺省 = 页面未落地，点击按 toast 处理 */
type Row = {
  key: string
  title: string
  sub: string
  icon: string
  url?: string
}

/** 回到顶部钮的出现阈值：3版稿 .totop 滚过 380pt 后出现。
 *  `usePageScroll` 的单位是逻辑 px（= 稿的 pt），**不是** scss 里的 rpx，不 ×2。 */
const TOTOP_THRESHOLD = 380

export default function Profile() {
  const [profile, setProfile] = useState<ProfileView | null>(null)
  const [showTop, setShowTop] = useState(false)
  /** 退出登录 in-flight 守卫：确认弹窗出现前快速双击，只允许走一轮注销 */
  const [loggingOut, setLoggingOut] = useState(false)

  /**
   * 顶部留白。3版稿的导航行只有原生胶囊（标题是 `sr-only`），没有可视顶栏 UI，
   * 所以不挂 `top-bar`，只按同一套胶囊栅格把内容顶下去，否则个人头部会压到
   * 刘海与原生胶囊上。数值来源与 `top-bar` 一致（`@/lib/nav-metrics`）。
   */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  const { status: authStatus, user: authUser } = useAuth()
  /** 只有**确定**未登录才显示登录引导（`unknown` = 冷启动 `GET /me` 还没回来） */
  const anonymous = authStatus === 'anonymous'

  /**
   * 拿到真实登录态后才打 `GET /profile`。
   *
   * 依赖 `authUser?.id` 而不是只有 `authStatus`：换账号是 `authed → authed`，
   * 只看状态不会重拉，页面上会短暂留着上一个账号的数据。
   *
   * **两处防串号，缺一不可**（独立审查的 P1：跨账号 stale write）：
   * 1. effect 开头先 `setProfile(null)` —— 否则 `authed(A) → authed(B)` 之间，
   *    渲染用的 `profile?.user ?? authUser` 里还挂着 A 的那份 `profile`；
   * 2. 取数包成 `cancellable`（cleanup 里取消）—— 换账号 / 退出时，上一轮请求的响应必须丢弃。
   *    只比对「响应的 user.id === 发请求时的 user.id」**不够**：那只证明响应属于当时的用户，
   *    不能证明现在登录的还是同一个人 —— A 的响应在 B 登录之后回来时，上面那条同样成立，
   *    于是 B 会短暂看到 A 的昵称、商品、愿望和统计。
   */
  useEffect(() => {
    setProfile(null)
    if (authStatus !== 'authed' || !authUser) return

    const forUserId = authUser.id
    const load = cancellable(
      () => loadProfile(),
      (next) => next !== null && next.user.id === forUserId,
    )
    void load.promise.then((next) => {
      if (next) setProfile(next)
    })

    return load.cancel
  }, [authStatus, authUser])

  /**
   * 只使用**真实数据**，不回退 mock（演示构建的回退口径见 fetchers）。
   *
   * 已知取舍：本页是 Tab 页，切走再切回不会重新挂载，所以「发布 / 成交之后回到我的」
   * 看到的是上次拉取的计数，要等登录态变化或重进小程序才刷新（要更实时就得加
   * `useDidShow` 重拉，属于后续改动）。
   */
  const user = profile?.user ?? authUser
  const orderCount = profile?.orderCount ?? 0

  const verified = user?.authStatus === 'VERIFIED'

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > TOTOP_THRESHOLD))

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  /** 格子 / 行的统一去向：有 url 就跳（区分 tab 页），没有就是页面未落地 */
  const go = (label: string, url?: string, tab?: boolean) => {
    if (!url) {
      toast(`${label}待接入`)
      return
    }
    if (tab) {
      void Taro.switchTab({ url })
      return
    }
    void Taro.navigateTo({ url })
  }

  /** 认证胶囊：进校园认证页（已认证看状态，未认证去认证） */
  const openVerify = () => void Taro.navigateTo({ url: '/pages/verify/index' })

  /** 退出登录：确认后先注销服务端会话、再清本地（顺序说明见文件头） */
  const onLogout = () => {
    if (loggingOut) return
    setLoggingOut(true)
    void (async () => {
      try {
        const confirmed = await Taro.showModal({
          title: '退出登录？',
          content: '退出后需要重新登录才能继续使用鱼小应。',
          cancelText: '取消',
          confirmText: '退出登录',
        })
        if (!confirmed.confirm) return
        const serverRevoked = await revokeServerSession()
        if (!serverRevoked) {
          await Taro.showModal({
            title: '已在本机退出',
            content: '服务器没有响应，登录会话可能仍然有效。联网后建议再退出一次。',
            showCancel: false,
            confirmText: '知道了',
          })
        }
        clearLocalSession()
      } finally {
        setLoggingOut(false)
      }
    })()
  }

  /**
   * 数字栏（Owner 修订：只摆数字不摆图标）。收藏 / 足迹 / 关注功能未上线恒 0，
   * 愿望是真实计数；四格都在拿到 profile 前按 0 显示，到手后换真实 / 演示数字。
   */
  const STAT_CELLS: StatCell[] = [
    { key: 'favorites', label: '我的收藏', count: profile?.favoritesCount ?? 0 },
    { key: 'history', label: '历史浏览', count: profile?.historyCount ?? 0 },
    { key: 'follow', label: '我的关注', count: profile?.followCount ?? 0 },
    {
      key: 'wish',
      label: '我的愿望',
      url: '/pages/wish/index',
      tab: true,
      count: profile?.stats.activeWishes ?? 0,
    },
  ]

  /**
   * 图标栏（Owner 修订：右上角红色小圆点内显数量，纯 --danger）。
   * 圆点等价于原数字角标的「有内容」信号：全部订单 = orderCount、
   * 在售 = activeListings，> 0 才显示；卖出 / 买入 / 评价没有数据源，不出点。
   */
  const TRADE_CELLS: IconCell[] = [
    {
      key: 'orders',
      label: '全部订单',
      icon: ICONS.profileOrder,
      url: '/pages/orders/index',
      count: profile === null ? 0 : orderCount,
    },
    {
      key: 'onsale',
      label: '在售',
      icon: ICONS.profileOnsale,
      url: '/pages/mylist/index',
      count: profile?.stats.activeListings ?? 0,
    },
    // 卖出 / 买入与全部订单同页（orders 已分视角），先落默认的「我买到的」
    { key: 'sold', label: '卖出', icon: ICONS.profileSold, url: '/pages/orders/index' },
    { key: 'bought', label: '买入', icon: ICONS.profileBought, url: '/pages/orders/index' },
    { key: 'review', label: '评价', icon: ICONS.profileReview },
  ]

  /**
   * 帮助与设置。Owner 修订：去掉「编辑个人资料」（头像昵称跟随微信，本页可编辑的
   * 只有个性签名）与「隐私」（入口在设置页里）两行。
   */
  const SETTING_ROWS: Row[] = [
    {
      key: 'settings',
      title: '设置',
      sub: '通知提醒与账号安全',
      icon: ICONS.settingsMuted,
      url: '/pages/settings/index',
    },
    { key: 'feedback', title: '意见反馈', sub: '提交建议与问题反馈', icon: ICONS.feedbackMuted },
    { key: 'service', title: '联系客服', sub: '在线客服与常见问题', icon: ICONS.serviceMuted },
    { key: 'about', title: '关于与版本', sub: '版本信息与用户协议', icon: ICONS.infoMuted },
  ]

  /**
   * 「帮助与设置」卡（Owner 修订后唯一带底部阴影的卡）：登录 / 未登录两种形态共用；
   * 退出登录行只在登录态出现（3版稿的「清除演示数据」不渲染，无可清的本地数据）。
   */
  const settingsPanel = (withLogout: boolean) => (
    <View className="profile__panel profile__panel--settings">
      <View className="profile__sec-label">帮助与设置</View>
      <View className="profile__list">
        {SETTING_ROWS.map((row) => (
          <View key={row.key} className="profile__row-item" onClick={() => go(row.title, row.url)}>
            <View className="profile__row-disc">
              <Image className="profile__row-ic" src={row.icon} mode="aspectFit" />
            </View>
            <View className="profile__row-main">
              <Text className="profile__row-title">{row.title}</Text>
              <Text className="profile__row-sub">{row.sub}</Text>
            </View>
            <Image className="profile__row-chev" src={ICONS.chevronRightMuted} mode="aspectFit" />
          </View>
        ))}
      </View>
      {withLogout ? (
        <View className="profile__list">
          <View className="profile__row-item is-danger" onClick={onLogout}>
            <View className="profile__row-disc is-danger">
              <Image className="profile__row-ic" src={ICONS.power} mode="aspectFit" />
            </View>
            <View className="profile__row-main">
              <Text className="profile__row-title">退出登录</Text>
              <Text className="profile__row-sub">退出后需要重新登录才能继续使用</Text>
            </View>
            <Image className="profile__row-chev" src={ICONS.chevronRightMuted} mode="aspectFit" />
          </View>
        </View>
      ) : null}
    </View>
  )

  /** 版权行：在卡片外面（Owner 指定的组合 logo：鱼形标 + 鱼小应 YUXIAOYING） */
  const footer = (
    <View className="profile__footer">
      <Image className="profile__footer-logo" src={brandLockup} mode="aspectFit" />
      <Text className="profile__footer-copy">©2026 鱼小应，版权所有</Text>
    </View>
  )

  /**
   * 未登录：只给登录引导 + 帮助与设置。数字栏 / 图标栏不渲染 —— 这一屏的任务是
   * 把用户送去登录，摆一排大多不可用的入口只会稀释登录引导。
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
          {settingsPanel(false)}
          {footer}
        </View>
      </View>
    )
  }

  /**
   * 本地有会话、但 `GET /me` 还没回来：给一个最小占位。
   *
   * 不能落到下面的「已登录」布局 —— 那一层的身份在 `authUser` 为空时会退回
   * 演示账号，等于把一个陌生人显示成当前用户。等 store 广播后再渲染。
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

  const renderStatCell = (cell: StatCell) => (
    <View
      key={cell.key}
      className="profile__cell"
      onClick={() => go(cell.label, cell.url, cell.tab)}
    >
      <Text className="profile__cell-num num">{cell.count}</Text>
      <Text className="profile__cell-label">{cell.label}</Text>
    </View>
  )

  const renderIconCell = (cell: IconCell) => (
    <View
      key={cell.key}
      className="profile__cell"
      onClick={() => go(cell.label, cell.url, cell.tab)}
    >
      <View className="profile__cell-tile">
        <Image className="profile__cell-ic" src={cell.icon} mode="aspectFit" />
        {cell.count && cell.count > 0 ? (
          <View className="profile__cell-dot num">{cell.count > 99 ? '99+' : cell.count}</View>
        ) : null}
      </View>
      <Text className="profile__cell-label">{cell.label}</Text>
    </View>
  )

  return (
    <View className="profile">
      <View className="profile__hero-bg" />

      <View className="profile__body" style={{ paddingTop: `${navHeight + 8}px` }}>
        {/* 个人头部：头像 / 昵称 + 认证胶囊 / 签名 / 扫码（与头像同行对齐，无编辑钮） */}
        <View className="profile__head">
          <View className="profile__avatar">
            {/* 契约 `MeSchema.avatarUrl` 可为 null：空就画人形占位，不拿别人的头像顶上 */}
            {user.avatarUrl ? (
              <Image className="profile__avatar-img" src={user.avatarUrl} mode="aspectFill" />
            ) : (
              <Image className="profile__avatar-ph" src={ICONS.user} mode="aspectFit" />
            )}
          </View>
          <View className="profile__info">
            <View className="profile__name-row">
              <Text className="profile__name">{user.nickname}</Text>
              {/* 认证状态本身就是入口：已认证进认证页看状态，未认证去认证 */}
              <View className="profile__auth" onClick={openVerify}>
                <Text className="profile__auth-txt">
                  {verified ? '已认证' : '未认证，前往认证'}
                </Text>
                <Image
                  className="profile__auth-arrow"
                  src={ICONS.chevronRightMuted}
                  mode="aspectFit"
                />
              </View>
            </View>
            {/* 签名行（3版稿 .psig）：展示行，没写也默认出现（契约暂无签字段，见文件头）。
                稿里 data-route 是 action:setSignature，编辑入口未落地先按 toast 占位 */}
            <View className="profile__sig" onClick={() => toast('个性签名待接入')}>
              <Image className="profile__sig-ic" src={ICONS.editAccent} mode="aspectFit" />
              <Text className="profile__sig-txt">诚信面交，先验货后付款</Text>
            </View>
          </View>
          {/* 扫码：与头像同一行对齐（撑满头像高度让图标与头像同心），直通扫码页 */}
          <View
            className="profile__scanbtn"
            onClick={() => void Taro.navigateTo({ url: '/pages/scan/index' })}
          >
            <Image className="profile__scanbtn-ic" src={ICONS.scanAccent} mode="aspectFit" />
          </View>
        </View>

        {/* 数字栏卡：只摆数字不摆图标 */}
        <View className="profile__panel profile__panel--stats">
          <View className="profile__grid profile__grid--4">{STAT_CELLS.map(renderStatCell)}</View>
        </View>

        {/* 图标栏卡：右上角红点代替原数字角标 */}
        <View className="profile__panel profile__panel--trade">
          <View className="profile__grid profile__grid--5">{TRADE_CELLS.map(renderIconCell)}</View>
        </View>

        {settingsPanel(true)}

        {footer}
      </View>

      {/* 3版稿 .totop：滚过一屏后浮现的回到顶部悬浮钮（非吸顶元素） */}
      <View className={`profile__totop${showTop ? ' is-show' : ''}`} onClick={backToTop}>
        <View className="profile__totop-arrow" />
      </View>
    </View>
  )
}
