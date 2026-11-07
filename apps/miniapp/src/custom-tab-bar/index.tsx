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
 *
 * #629：出物页已从 Tab 页改为**二级页**，`tabBar.list` 只剩 4 个普通 Tab。底栏仍是 5 个
 * 槽位（4 个 Tab + 中间的发布**动作钮**），但中间格不是 Tab：点它用 `Taro.navigateTo`
 * 压栈打开出物页，所以它没有选中态，也不走 `switchTab` 的胶囊过渡。槽位索引仍按 5 格算
 * （`TAB_SLOT_RPX`），别把中间格从 `TAB_ITEMS` 里删掉 —— 删了消息/我的会各左移一格。
 */
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import {
  gateUnreadForNotifyPrefs,
  NOTIFY_PREFS_EVENT,
  readNotifyPrefsFromStorage,
} from '@/features/settings/unread-badge'
import { TAB_SLOT_RPX, TAB_TRANSITION_MS } from '@/lib/tab-transition'
import {
  currentTabRoute as currentRoute,
  readTabTransition,
  switchTabWithTransition,
  TABBAR_ROUTE_EVENT,
} from '@/lib/tabbar-sync'
import './index.scss'

/** 普通 Tab：`switchTab` 能切换的那 4 个页面 */
type TabKey = 'home' | 'wish' | 'chat' | 'profile'

/** 底栏 5 个槽位的 key —— 4 个 Tab + 中间那一格发布动作钮（#629 起不是 Tab） */
type BarKey = TabKey | 'publish'

type TabItem = {
  key: BarKey
  label: string
  /** 点击后用哪条导航 API 打开的绝对路径：Tab 走 `switchTab`，动作钮走 `navigateTo` */
  path: string
  /** 与页面 route / hash 匹配的片段；动作钮没有（它不是常驻的 Tab 页） */
  route?: string
  /** `tab` = 普通 Tab（有选中态），`action` = 中间动作钮（压栈打开出物页） */
  kind: 'tab' | 'action'
  icon: string
  iconOn: string
}

/** 收窄成「普通 Tab」的判据：`route` 只在 Tab 项上存在 */
function isTabSlot(item: TabItem): item is TabItem & { key: TabKey; route: string } {
  return item.kind === 'tab' && item.route !== undefined
}

/**
 * 底栏 5 个槽位，顺序即渲染顺序。4 个 `kind: 'tab'` 项必须与 `app.config.ts` 的
 * `tabBar.list` 完全一致（`tests/sell-secondary-page.test.ts` 守着这条）；中间那一格
 * 是动作钮，不在 `tabBar.list` 里 —— 它的存在只为占住第 3 个槽位，让消息/我的落回原位。
 */
const TAB_ITEMS: TabItem[] = [
  {
    key: 'home',
    label: '首页',
    path: '/pages/home/index',
    route: 'pages/home/index',
    kind: 'tab',
    icon: ICONS.tabHomeMuted,
    iconOn: ICONS.tabHomeBrand,
  },
  {
    key: 'wish',
    label: '许愿',
    path: '/pages/wish/index',
    route: 'pages/wish/index',
    kind: 'tab',
    icon: ICONS.tabWishMuted,
    iconOn: ICONS.tabWishBrand,
  },
  // 中间「出物」是凸起钮：品牌渐变圆底 + 反白加号，与其余 4 个槽位一样用图标资源绘制。
  // #629 起它压栈打开出物页（那一页已是二级页），所以没有 `route`、没有选中态。
  {
    key: 'publish',
    label: '出物',
    path: '/pages/sell/index',
    kind: 'action',
    icon: ICONS.plusWhite,
    iconOn: ICONS.plusWhite,
  },
  {
    key: 'chat',
    label: '消息',
    path: '/pages/chat/index',
    route: 'pages/chat/index',
    kind: 'tab',
    icon: ICONS.tabMessageMuted,
    iconOn: ICONS.tabMessageBrand,
  },
  {
    key: 'profile',
    label: '我的',
    path: '/pages/profile/index',
    route: 'pages/profile/index',
    kind: 'tab',
    icon: ICONS.tabMeMuted,
    iconOn: ICONS.tabMeBrand,
  },
]

function capsuleMotion() {
  const motion = readTabTransition()
  if (!motion) return null
  return {
    id: motion.id,
    style: {
      '--tab-capsule-from': `${motion.from}rpx`,
      '--tab-capsule-to': `${motion.to}rpx`,
      animationName: 'tab-capsule-enter',
      animationDuration: `${TAB_TRANSITION_MS}ms`,
      // 新实例挂载较晚时接上同一时间线，而不是从头多播一次。
      animationDelay: `${Math.min(0, motion.startedAt - Date.now())}ms`,
    },
  }
}

function currentTabKey(): TabKey {
  const route = currentRoute()
  for (const item of TAB_ITEMS) {
    if (isTabSlot(item) && route.includes(item.route)) return item.key
  }
  return 'home'
}

/**
 * ⚠️ 选中态**不能**在渲染期现读 `currentRoute()`（#562 根因 2）：本实例在被别的页面压住
 * 期间仍然挂载，未读快照（`useUnreadSnapshot` / `hydrateUnread`）、`useAuth()` 等异步源
 * 随时会让它重渲染，那时栈顶已不是自己 —— 现读会算出「别的页」→ 把底栏画成别的选中项，
 * 回到本页时 sync 里 `setActive` 与离开前同值 → React bail out → 没人再求值 →
 * 上一次画出来的底栏被原样显示。所以选中态跟着 `active` **状态**走（只由 onShow 广播更新）。
 */

/**
 * #612：最终高光位置仍从实际路由派生；共享意图只为目标实例提供短暂的起点。
 * 不延迟 switchTab、不在点击时抢改选中态；快速打断从同一曲线的位置续接。
 * 槽位仍用显式 rpx：内容区 654rpx / 5 = 130.8rpx，不混用百分比/calc。
 */

export default function CustomTabBar() {
  const [active, setActive] = useState<TabKey>(() => currentTabKey())
  const [motion, setMotion] = useState(capsuleMotion)
  /**
   * 动作钮的连点锁：`Taro.navigateTo` 是异步的，第二次点击可能在第一次跳转生效前就进来，
   * 于是压出两个出物页（返回一次还停在出物页）。上锁到 promise 落定为止。
   */
  const navigatingRef = useRef(false)
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
   * 演示构建（`TARO_APP_MOCK=1`，本地没有后端）的红点兜底。排除系统会话 —— 它的未读由「通知」
   * 承载，两边都算会重复计。
   *
   * 真实构建下是 `undefined`：未读数只能来自真实接口，读不到就是「不知道」，
   * 不能用 fixture 先亮一颗点进去什么都没有的幽灵红点。兜底由这里注入而不是
   * `features/chat/unread` 内判断构建开关 —— store 不该知道 fixture 的存在。
   */
  const demoUnread = useMemo(() => (MOCK_FALLBACK_ENABLED ? demoTabbarUnread : undefined), [])

  /**
   * 通知偏好（设置页「通知明细」四行）对底栏红点的闸门。
   *
   * 存储同步读（`getStorageSync`），但底栏实例常驻每个 Tab 页，设置页改开关时它
   * 不会重渲染 —— 所以除了挂载时读一次，还订阅 `NOTIFY_PREFS_EVENT`：设置页每写
   * 一次通知开关就广播一次，这里把版本号 +1，强制下面的徽标 effect 按新偏好重算
   * （同 `lib/tabbar-sync` 的广播模式）。读失败视为「没存过」，按设置页那份默认值处理。
   */
  const [prefsVersion, setPrefsVersion] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 重算只由 prefsVersion（事件广播）驱动，存储不是响应式来源
  const notifyPrefs = useMemo(
    () => readNotifyPrefsFromStorage((key) => Taro.getStorageSync(key)),
    [prefsVersion],
  )

  useEffect(() => {
    const reread = () => setPrefsVersion((version) => version + 1)
    Taro.eventCenter.on(NOTIFY_PREFS_EVENT, reread)
    return () => {
      Taro.eventCenter.off(NOTIFY_PREFS_EVENT, reread)
    }
  }, [])

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
    //
    // 进 `unreadBadgeText` 前先过通知偏好闸门（`gateUnreadForNotifyPrefs`）：用户在
    // 设置页关掉的类别不计入红点 —— 关掉给 `0`（明确的「不计入」），开着才透传
    // （包括 `null`，「不知道」的语义原样保留）。
    if (unread && unread.ownerId === userId) {
      const gated = gateUnreadForNotifyPrefs(unread, notifyPrefs)
      setBadge(
        unreadBadgeText({
          conversations: gated.conversations,
          notifications: gated.notifications,
          previous: badge,
        }),
      )
      return
    }
    // 快照还没到位（补请求在途）。演示构建（`TARO_APP_MOCK=1`，本地没有后端）维持 fixture 现算
    // 口径，真实构建保持上一帧 —— 等 `hydrateUnread` 的真实结果落地再决定，
    // 不能用 fixture 先亮一个数再说，也不能因为「还没到」就把已知的徽标熄掉。
    if (!demoUnread) return
    const gatedFallback = gateUnreadForNotifyPrefs(demoUnread(), notifyPrefs)
    setBadge(
      unreadBadgeText({
        conversations: gatedFallback.conversations,
        notifications: gatedFallback.notifications,
        previous: badge,
      }),
    )
  }, [authStatus, userId, unread, demoUnread, notifyPrefs, badge])

  // 选中态同步：挂载时同步一次 + 监听 Tab 页 onShow 广播（lib/tabbar-sync）。
  // 复用实例不重新渲染，靠广播是它唯一能感知「我又被显示」的机会。
  useEffect(() => {
    const sync = () => {
      setActive(currentTabKey())
      const next = capsuleMotion()
      setMotion((previous) => (previous?.id === next?.id ? previous : next))
    }
    sync()
    Taro.eventCenter.on(TABBAR_ROUTE_EVENT, sync)
    return () => {
      Taro.eventCenter.off(TABBAR_ROUTE_EVENT, sync)
    }
  }, [])

  const go = (item: TabItem) => {
    // 中间动作钮：用 navigateTo 压栈打开出物页 —— 它已经不是 Tab 页，switchTab 打不开它。
    if (item.kind === 'action') {
      // 连点不叠加：跳转在途时忽略后续点击（异步 API，光靠 active 早退挡不住）。
      if (navigatingRef.current) return
      navigatingRef.current = true
      void Taro.navigateTo({ url: item.path })
        .catch(() => undefined)
        .finally(() => {
          navigatingRef.current = false
        })
      return
    }
    if (item.key === active) return
    // 立即导航；只有实际到达的普通 Tab 会消费动效意图。
    switchTabWithTransition(item.path)
  }

  return (
    <View className="tabbar">
      {/*
        选中胶囊：纯透明液体玻璃高光，位置由 `active`（当前页面路径）直接派生，
        无有效意图时直接落位；仅装饰层按意图重播，不重建页面或列表。坐标保持显式 rpx。
        是 .tabbar 的第一个子元素 → 图标/文字（后面的兄弟）天然盖在它上面；
        `pointer-events: none` 让点击穿透到 tab。
      */}
      <View
        key={motion?.id ?? 0}
        className="tabbar__capsule"
        style={{
          ...motion?.style,
          transform: `translateX(${
            Math.max(
              0,
              TAB_ITEMS.findIndex((item) => item.key === active),
            ) * TAB_SLOT_RPX
          }rpx)`,
        }}
      />
      {TAB_ITEMS.map((item) => {
        const on = item.kind === 'tab' && item.key === active
        if (item.kind === 'action') {
          /**
           * 中间凸起钮是**动作**不是 Tab（#629）：点它压栈打开出物页，所以它没有选中态，
           * 也不带 `is-on` —— 出物页不在 `tabBar.list` 里，用户在那里看不到这条底栏。
           */
          return (
            <View key={item.key} className="tabbar__tab tabbar__tab--pub" onClick={() => go(item)}>
              <View className="tabbar__pub">
                <Image className="tabbar__plus" src={item.icon} mode="aspectFit" />
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
