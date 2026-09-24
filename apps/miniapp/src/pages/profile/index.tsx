import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll } from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'
import brandLockup from '@/assets/brand/brand-lockup.png'
import { ICONS } from '@/assets/lib-icons'
import { clearLocalSession, revokeServerSession, useAuth } from '@/features/auth/store'
import { loadProfile, type ProfileView } from '@/features/fetchers'
import { realCounts } from '@/features/profile/counts'
import { readSignature, saveSignature } from '@/features/profile/signature'
import { signatureFirstLine } from '@/features/profile/signature-text'
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
 * `GET /profile` 后按真实值渲染，拿不到就显示占位（收藏 / 足迹 / 关注显示 `—`、
 * 圆点不显示），不回退 mock（演示构建的回退口径见 fetchers `loadProfile` 的 catch）。
 *
 * **已经 Owner 确认的取舍**：
 * - 签名行**可编辑**（2026-09-20 拍板）：点击弹输入框、真实输入并保存到本机
 *   （契约暂无签字段，见 `features/profile/signature.ts`）；只展示**首行**，过长由
 *   省略号收尾，未设置过时显示「设置个性签名」占位；
 * - 「编辑个人资料」「隐私」两行不渲染：头像昵称跟随微信、隐私入口在设置页里；
 * - 稿里的「清除演示数据」行不渲染：本地没有任何演示数据存储可清。
 *
 * **退出登录**与设置页同一套两步走：先 `revokeServerSession()` 把服务端会话注销
 * （失败要告知，否则用户以为退了、会话其实还有效），再 `clearLocalSession()`
 * 广播 `anonymous`，本页随之切到未登录形态。
 */

/**
 * 数字栏格子（3版稿 4 格栏改纯数字）。
 *
 * `count` 为 `null` = **系统不知道**（未登录 / 还没拿到 profile / 契约没有该端点），
 * 页面显示 `—`；只有真实拿到数字才显示数字。收藏 / 足迹 / 关注当前没有数据源，
 * 真实构建恒为 `null`（见 `fetchers.ts` 的 `ProfileView`）。
 */
type StatCell = {
  key: string
  label: string
  url?: string
  tab?: boolean
  count: number | null
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

/**
 * 带输入框的弹窗（微信基础库 2.17.1+ 的 `editable`）。
 *
 * Taro 4 的 `showModal` 类型还没收这两个字段
 * （`@tarojs/taro/types/api/ui/interaction.d.ts` 的 `Option` 只有 `content`，
 * `SuccessCallbackResult` 也不回传 `content`），所以这里补一层**窄**类型桥接 ——
 * 只声明缺的那两个字段，其余仍走 Taro 的类型检查，不放松类型、也不用 `any`。
 */
type EditableModalOption = Taro.showModal.Option & {
  /** 弹窗内是否带输入框；`true` 时 `content` 是输入框初值 */
  editable: boolean
  placeholderText?: string
}
type EditableModalResult = Taro.showModal.SuccessCallbackResult & { content?: string }

function showEditableModal(option: EditableModalOption): Promise<EditableModalResult> {
  return Taro.showModal(option) as Promise<EditableModalResult>
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
  /**
   * 三个来自真接口的计数（`null` = 还没拿到 / 请求失败）。折叠成 0 就等于把
   * 「未知」说成「你有 0 条」，见 `@/features/profile/counts` 的口径说明。
   */
  const counts = realCounts(profile)

  const verified = user?.authStatus === 'VERIFIED'

  /**
   * 个性签名（本机存储，见 `features/profile/signature.ts`）。
   *
   * **渲染期同步读**（`readSignature` 是同步的本地读，很便宜）：放 effect 里读会让
   * 已设置签名的用户每次进本页先看到一帧「设置个性签名」占位、再跳成真实签名。
   * 身份（`user?.id`）一变就地重读 —— 换账号不能把上一个账号的签名继续显示在新账号
   * 名下（与 `loadProfile` 的 cancellable 防串号同一个理由）。
   */
  const [sig, setSig] = useState<{ forUser: string | null; text: string | null }>(() => ({
    forUser: user?.id ?? null,
    text: user?.id ? readSignature(user.id) : null,
  }))
  const userId = user?.id ?? null
  if (sig.forUser !== userId) {
    setSig({ forUser: userId, text: userId ? readSignature(userId) : null })
  }
  const signature = sig.text

  /** 编辑签名：弹输入框 → 存本机 → 重读展示；空输入 = 清除，回到「设置个性签名」 */
  const editSignature = () => {
    if (!userId) return
    void (async () => {
      let res: EditableModalResult
      try {
        res = await showEditableModal({
          title: '个性签名',
          editable: true,
          placeholderText: '设置个性签名',
          content: signature ?? '',
          confirmText: '保存',
          cancelText: '取消',
        })
      } catch (error) {
        // 老 Android 上「点取消 / 点蒙层」走的是 fail 回调（Taro 把 showModal 包成
        // reject），不是 cancel 分支；页面卸载 / 重复点击同理。一律按「没保存」处理，
        // 只留痕不打扰用户（真机上 showModal 一定存在，这里不会是「功能不可用」）。
        console.debug('[miniapp] 个性签名弹窗未完成，按未保存处理', error)
        return
      }
      if (!res.confirm) return
      // 不支持 `editable` 的基础库会忽略该参数：弹窗没有输入框，也**不回传 content**。
      // 不能把「平台没给内容」当成「用户清空了」（那会静默删掉已设置的签名）
      if (typeof res.content !== 'string') {
        toast('当前微信版本不支持编辑个性签名')
        return
      }
      if (!saveSignature(userId, res.content)) {
        toast('保存失败，请重试')
        return
      }
      setSig({ forUser: userId, text: readSignature(userId) })
      toast('已保存')
    })()
  }

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
   * 数字栏（Owner 修订：只摆数字不摆图标）。
   *
   * **`null` = 系统不知道 → 显示 `—`**，四格一律同口径：收藏 / 足迹 / 关注没有数据源
   * （契约无端点），真实构建恒为 `null`；愿望数来自 `stats.activeWishes`，但
   * **没拿到 profile 时也是 `null` 而不是 0**（`realCounts` 的未知态口径）。
   */
  const STAT_CELLS: StatCell[] = [
    { key: 'favorites', label: '我的收藏', count: profile?.favoritesCount ?? null },
    { key: 'history', label: '历史浏览', count: profile?.historyCount ?? null },
    { key: 'follow', label: '我的关注', count: profile?.followCount ?? null },
    {
      key: 'wish',
      label: '我的愿望',
      url: '/pages/wish/index',
      tab: true,
      count: counts.activeWishes,
    },
  ]

  /**
   * 图标栏（Owner 修订：右上角红色小圆点内显数量，纯 --danger）。
   * 圆点等价于原数字角标的「有内容」信号：全部订单 = orderCount、
   * 在售 = activeListings，> 0 才显示；卖出 / 买入 / 评价没有数据源，不出点。
   *
   * `count` 为 `undefined` = **不知道** → 不出点：点表示「这里有东西」，
   * 未知时既不该凭空出点（假消息），也不该显示 0（那是「确实没有」，同样是假话）。
   * 只有成功拿到 profile 才把真实数字交给圆点去判断。
   */
  const TRADE_CELLS: IconCell[] = [
    {
      key: 'orders',
      label: '全部订单',
      icon: ICONS.profileOrder,
      // 订单页按视角拆成两页后没有「全部」那一页了，落默认的「我买到的」
      url: '/pages/orders-buy/index',
      count: counts.orderCount ?? undefined,
    },
    {
      key: 'onsale',
      label: '在售',
      icon: ICONS.profileOnsale,
      url: '/pages/mylist/index',
      count: counts.activeListings ?? undefined,
    },
    // 订单页已按视角拆成两页：卖出 / 买入 各落对应那页
    { key: 'sold', label: '卖出', icon: ICONS.profileSold, url: '/pages/orders-sell/index' },
    { key: 'bought', label: '买入', icon: ICONS.profileBought, url: '/pages/orders-buy/index' },
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
              {/* 登录页只剩微信一条路，没有「注册」这个独立动作可点了（#198 审查 P2-2） */}
              <Text>去登录</Text>
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

  /** 签名展示文本：只取首行；空 = 没设置过（或已清空），渲染占位文案 */
  const sigText = signature ? signatureFirstLine(signature) : ''

  const renderStatCell = (cell: StatCell) => (
    <View
      key={cell.key}
      className="profile__cell"
      onClick={() => go(cell.label, cell.url, cell.tab)}
    >
      {/* `null` = 系统不知道（没有端点 / 还没拿到），显示 `—` 而不是 0 */}
      <Text className="profile__cell-num num">{cell.count ?? '—'}</Text>
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
            {/* 签名行（3版稿 .psig）：**点击可编辑**，值存本机（契约暂无签字段）。
                只展示**首行** —— 多行输入的其余行不显示，过长由 CSS 省略号收尾；
                没设置过渲染占位文案（`.is-ph`）。
                ⚠️ 他人视角的用户主页（页面尚未落地）要按同一口径只显首行，并额外给一个
                「点击展开全部」的入口；该页后续再改，这里先留提示 —— 本页**不加**展开 */}
            <View className="profile__sig" onClick={editSignature}>
              <Image className="profile__sig-ic" src={ICONS.editAccent} mode="aspectFit" />
              <Text className={`profile__sig-txt${sigText ? '' : ' is-ph'}`}>
                {sigText || '设置个性签名'}
              </Text>
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
