/**
 * 自定义 TabBar（设计稿的「居中悬浮玻璃胶囊 + 中间凸起发布钮」）。
 *
 * 目录名 `custom-tab-bar/` 是**微信/小程序的固定约定**：`app.json` 里 `tabBar.custom: true`
 * 时，框架不再渲染原生底栏，而是渲染这个目录下的组件（Taro 4 会识别并编译它，
 * 见 `@tarojs/webpack5-runner` 的 `MiniPlugin.js`「自定义 tabBar」）。
 *
 * 为什么用这套而不是「保留原生栏 + 页面里 hideTabBar()」：
 * 1. 原生栏彻底不渲染，不会出现「两套底栏叠加」；
 * 2. 本组件由框架渲染成真正的固定浮层，不依赖页面里的 `position: sticky`，
 *    因此页面根节点写不写 `overflow` 都不会让它失效（踩过这个坑）。
 *
 * 当前选中项从 `Taro.getCurrentPages()` 最后一项的 route 推断 —— 页面组件不需要再传
 * `active`，切页由 `switchTab` 驱动。浏览器预览（TARO_ENV=h5）里没有页面栈，
 * 改从 hash 路由读，保证预览与真机同一套组件。
 */
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { useAuth } from '@/features/auth/store'
import { hydrateUnread, unreadBadgeText, useUnreadSnapshot } from '@/features/chat/unread'
// 只为一个构建期常量就静态 import `@/features/fetchers`（900+ 行的取数 barrel）
// 会把整张取数图拖进底栏——而底栏在**每个** Tab 页都会渲染，属于冷启动必经路径。
// 常量真源本来就在 `features/load-failure.ts`。
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
// 演示兜底的 fixture 取值走 `mock-fallback`：生产构建由 `config/index.ts` 的 alias
// 换成零 `@/mock/*` 依赖的桩，fixture 子图不进底栏（底栏在每个 Tab 页都渲染）。
import { demoTabbarUnread } from '@/features/mock-fallback'
import { TABBAR_ROUTE_EVENT } from '@/lib/tabbar-sync'
import './index.scss'

type TabKey = 'home' | 'wish' | 'sell' | 'chat' | 'profile'

type TabItem = {
  key: TabKey
  label: string
  /** switchTab 用的绝对路径 */
  path: string
  /** 用于与页面 route / hash 匹配 */
  route: string
  icon: string
  iconOn: string
}

/** 顺序必须与 `app.config.ts` 的 `tabBar.list` 完全一致 */
const TAB_ITEMS: TabItem[] = [
  {
    key: 'home',
    label: '首页',
    path: '/pages/home/index',
    route: 'pages/home/index',
    icon: ICONS.tabHome,
    iconOn: ICONS.tabHomeOn,
  },
  {
    key: 'wish',
    label: '许愿',
    path: '/pages/wish/index',
    route: 'pages/wish/index',
    icon: ICONS.tabWish,
    iconOn: ICONS.tabWishOn,
  },
  // 中间「出物」是凸起钮，没有图标资源
  {
    key: 'sell',
    label: '出物',
    path: '/pages/sell/index',
    route: 'pages/sell/index',
    icon: '',
    iconOn: '',
  },
  {
    key: 'chat',
    label: '消息',
    path: '/pages/chat/index',
    route: 'pages/chat/index',
    icon: ICONS.tabMessage,
    iconOn: ICONS.tabMessageOn,
  },
  {
    key: 'profile',
    label: '我的',
    path: '/pages/profile/index',
    route: 'pages/profile/index',
    icon: ICONS.tabProfile,
    iconOn: ICONS.tabProfileOn,
  },
]

function currentRoute(): string {
  // 预览态（h5）没有页面栈，从 hash 路由取
  if (process.env.TARO_ENV === 'h5' && typeof window !== 'undefined') {
    return window.location.hash.replace(/^#/, '')
  }
  try {
    const pages = Taro.getCurrentPages()
    const last = pages[pages.length - 1] as { route?: string } | undefined
    return last?.route ?? ''
  } catch {
    return ''
  }
}

function currentTabKey(): TabKey {
  const route = currentRoute()
  const hit = TAB_ITEMS.find((item) => route.includes(item.route))
  return hit?.key ?? 'home'
}

/**
 * 唯一不渲染底栏的 Tab 页：设计稿该页（`小程序第1版。发布闲置publish-listing.html`）
 * **根本没有画底栏**（全文 grep `tabbar` 零命中）—— 发布表单要占满屏高，
 * 底栏浮在上面会压住提交区（Owner 2026-09-28 二次确认维持此设计）。
 *
 * `TAB_ITEMS` 里**保留** sell 项：`tabBar.list` 与 `switchTab` 仍需要它作为合法路由，
 * 隐藏只发生在本组件的渲染层。代价是该页只剩左上返回钮一个出口，
 * 所以 `pages/sell/index.tsx` 必须显示返回钮。
 *
 * ⚠️ 隐藏依赖 `currentRoute()` 的**渲染期求值**，而 tab-bar 实例挂载早于页面栈更新 ——
 * mount 首渲染时 route 还是上一页，tabbar 会先渲染出来；之后**唯一**能把早退判定
 * 「重新求值」的触发是 `setActive`（值变才重渲染）。所以 **sell 页也必须
 * `useDidShow(notifyTabbarRoute)` 广播**（2026-09-28 实测教训：漏了它，出物页底栏
 * 顶着上一页的高光常驻）。广播 → sync → setActive('sell') → 重渲染 → 早退生效。
 */
const HIDDEN_ROUTE = 'pages/sell/index'

/**
 * 选中胶囊（Owner 2026-09-28 拍板）：**不做动画、不存独立状态**，位置直接由 `active`
 * 派生（渲染时从 `TAB_ITEMS.findIndex` 求值），而 `active` 的唯一真源是「当前页面路径」
 * —— 每个 Tab 页 `useDidShow` 经 `lib/tabbar-sync` 广播，本组件同步。
 *
 * 历史教训（三次返工的根因，别再走回头路）：
 * 1. 任何「挂载时算一次」的状态都会残留 —— 实例被复用显示时不重新渲染；
 * 2. 任何「点击侧滑动 + 延迟 switchTab」的接力时序都会被切页时机打断；
 * 3. 槽位坐标必须是**显式 rpx**（`TAB_SLOT_RPX`）：750 设计稿下栏宽恒定
 *    （left/right 30rpx + border 2rpx×2 + padding 16rpx×2 → 内容区 654rpx，5 槽等分
 *    130.8rpx）。百分比/calc 的混合运算在 WXSS 运行时解析不可靠（实测偏位）。
 */
const TAB_SLOT_RPX = 130.8

export default function CustomTabBar() {
  const [active, setActive] = useState<TabKey>(() => currentTabKey())
  /** 「消息」tab 的未读徽标文案（#431 任务二：蓝点 → 红色数字胶囊）；`null` = 不显示 */
  const [badge, setBadge] = useState<string | null>(null)
  const { status: authStatus, user } = useAuth()
  /** 消息页发布的未读快照（见 `features/chat/unread.ts`）；没进过消息页时为 null */
  const unread = useUnreadSnapshot()

  /** 当前账号 id（已登录时非空），effect 依赖它而不是整个 user 对象 */
  const userId = user?.id ?? null

  /**
   * 换账号时**在渲染期**把徽标清空（`adjust-state-during-render`，与
   * `pages/chat/index.tsx` 的身份重置同一写法）。
   *
   * 为什么不能只靠下面的 effect：新账号的快照还没到手时（`unread` 仍是上一个账号的
   * 那份、或 `hydrateUnread` 失败后发的是两项 `null`），`unreadBadgeText` 的「保持上一帧」
   * 会把**上一个账号的未读数**原样留在屏幕上 —— 点进去是另一个账号的未读，等于报错数。
   * 数字比原来的小圆点更容易被当成具体事实，所以这里必须清零，让下面的 effect 从
   * 新账号的快照重新算。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    setBadge(null)
  }

  /**
   * 演示 / 开发构建（本地没有后端）的红点兜底。排除系统会话 —— 它的未读由「通知」
   * 承载，两边都算会重复计。
   *
   * 真实构建下是 `undefined`：未读数只能来自真实接口，读不到就是「不知道」，
   * 不能用 fixture 先亮一颗点进去什么都没有的幽灵红点。兜底由这里注入而不是
   * `features/chat/unread` 内判断构建开关 —— store 不该知道 fixture 的存在。
   */
  const demoUnread = useMemo(() => (MOCK_FALLBACK_ENABLED ? demoTabbarUnread : undefined), [])

  /**
   * 冷启动补快照（#129 review P1；#89 收口会话未读那一分量）。
   *
   * 底栏在每个 Tab 页都渲染，用户可能一次都不进消息页 —— 那时没有任何人发布快照。
   * 这里在「已登录 + 本次账号还没有快照」时补一次真实数据：
   * `GET /notifications/unread-count` 与 `GET /conversations/unread-count`
   * （`hydrateUnread` 内部按账号去重，多 Tab 实例只打一次）。
   *
   * 会话未读此前无论哪条路径都来自 fixture（#89 明写的既有债），于是底栏那颗点
   * 与「是否真的还有未读」毫无关系：通知未读为 0、接口失败时它照样亮，也从不随已读
   * 熄灭。现在两项都是真值（#291 起会话未读走专用聚合端点，不再对列表首页求和），
   * 真实接口失败即「不知道」。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !userId) return
    hydrateUnread(userId, demoUnread)
  }, [authStatus, userId, demoUnread])

  useEffect(() => {
    // 未登录不显示徽标：未读数只能来自已登录账号，匿名时亮起等于在「我的」登录引导卡上
    // 展示别人的未读。
    if (authStatus !== 'authed' || !userId) {
      setBadge(null)
      return
    }
    // 未读消息 + 未读通知的合计，决定消息 tab 的数字胶囊。
    // 优先用本次账号的快照 —— 页内「进会话 / 逐条已读通知」清掉的未读，徽标同步递减。
    // 快照按账号校验：Chat 页实例被销毁（守卫 reLaunch 兜底重开整栈）时没人清快照，
    // 不带归属校验就会拿上一个账号的已读视角熄掉新账号的徽标。
    //
    // 判定走 `unreadBadgeText`（纯函数、有用例）：有分量 `null`（「不知道」：
    // 列表未就绪 / 加载失败 / 真实接口不可达）时**不下「没有未读」的结论、保持上一帧** ——
    // 否则一枚本来亮着的徽标会莫名消失，而用户其实还有未读。
    if (unread && unread.ownerId === userId) {
      setBadge(
        unreadBadgeText({
          conversations: unread.conversations,
          notifications: unread.notifications,
          previous: badge,
        }),
      )
      return
    }
    // 快照还没到位（补请求在途）。演示 / 开发构建（本地没有后端）维持 fixture 现算
    // 口径，真实构建保持上一帧 —— 等 `hydrateUnread` 的真实结果落地再决定，
    // 不能用 fixture 先亮一个数再说，也不能因为「还没到」就把已知的徽标熄掉。
    if (!demoUnread) return
    const fallback = demoUnread()
    setBadge(
      unreadBadgeText({
        conversations: fallback.conversations,
        notifications: fallback.notifications,
        previous: badge,
      }),
    )
  }, [authStatus, userId, unread, demoUnread, badge])

  // 选中态同步：挂载时同步一次 + 监听 Tab 页 onShow 广播（lib/tabbar-sync）。
  // 复用实例不重新渲染，靠广播是它唯一能感知「我又被显示」的机会。
  useEffect(() => {
    const sync = () => setActive(currentTabKey())
    sync()
    Taro.eventCenter.on(TABBAR_ROUTE_EVENT, sync)
    return () => {
      Taro.eventCenter.off(TABBAR_ROUTE_EVENT, sync)
    }
  }, [])

  const go = (item: TabItem) => {
    if (item.key === active) return
    // 只负责发起切换；选中态由目标页 onShow 的广播驱动（路径真源，无动画）
    void Taro.switchTab({ url: item.path }).catch(() => undefined)
  }

  // 出物页早退：写在所有 hook 之后（hook 数量不能随路由变化）。
  // 判定是渲染期求值 —— 依赖 sell 页自己的 onShow 广播触发 setActive 重渲染，
  // 否则 mount 时（栈未更新）渲染出的底栏会带着旧页高光常驻（实测教训）。
  if (currentRoute().includes(HIDDEN_ROUTE)) return null

  return (
    <View className="tabbar">
      {/*
        选中胶囊：纯透明液体玻璃高光，位置由 `active`（当前页面路径）直接派生，
        瞬时落位、无过渡。槽位坐标显式 rpx（`TAB_SLOT_RPX`，750 稿恒定）。
        是 .tabbar 的第一个子元素 → 图标/文字（后面的兄弟）天然盖在它上面；
        `pointer-events: none` 让点击穿透到 tab。
      */}
      <View
        className="tabbar__capsule"
        style={{
          transform: `translateX(${
            Math.max(
              0,
              TAB_ITEMS.findIndex((item) => item.key === active),
            ) * TAB_SLOT_RPX
          }rpx)`,
        }}
      />
      {TAB_ITEMS.map((item) => {
        const on = item.key === active
        if (item.key === 'sell') {
          /**
           * 中间的凸起钮也要给 `is-on`：设计稿（D1 第 04 帧）里当前 Tab 的**文字**是品牌色，
           * 凸起钮本身恒为品牌渐变。少了这个 class，用户在「出物」页时整条底栏没有任何
           * 选中反馈——按钮「看起来一样」但点了有反应，是最容易让人以为坏了的状态。
           */
          return (
            <View
              key={item.key}
              className={`tabbar__tab tabbar__tab--pub${on ? ' is-on' : ''}`}
              onClick={() => go(item)}
            >
              <View className="tabbar__pub">
                <View className="tabbar__plus" />
              </View>
              <Text className="tabbar__label">{item.label}</Text>
            </View>
          )
        }
        return (
          <View
            key={item.key}
            className={`tabbar__tab${on ? ' is-on' : ''}`}
            onClick={() => go(item)}
          >
            <View className="tabbar__icon">
              <Image className="tabbar__img" src={on ? item.iconOn : item.icon} mode="aspectFit" />
              {item.key === 'chat' && badge ? (
                // 未读数字胶囊（#431 任务二）：1 位 = 正圆、2 位（含 99+）= 胶囊，
                // 形状规则见 index.scss 的 num-badge
                <View className={`tabbar__n num${badge.length > 1 ? ' is-multi' : ''}`}>
                  {badge}
                </View>
              ) : null}
            </View>
            <Text className="tabbar__label">{item.label}</Text>
          </View>
        )
      })}
    </View>
  )
}
