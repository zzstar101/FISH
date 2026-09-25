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
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { useAuth } from '@/features/auth/store'
import {
  badgeShouldLight,
  hydrateUnread,
  refreshUnread,
  useUnreadSnapshot,
} from '@/features/chat/unread'
import { MOCK_FALLBACK_ENABLED } from '@/features/fetchers'
import { conversations, unreadNotificationCount } from '@/mock/api'
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
 * 底栏浮在上面会压住提交区。
 *
 * `TAB_ITEMS` 里**保留** sell 项：`tabBar.list` 与 `switchTab` 仍需要它作为合法路由，
 * 隐藏只发生在本组件的渲染层。代价是该页只剩左上返回钮一个出口，
 * 所以 `pages/sell/index.tsx` 必须显示返回钮。
 */
const HIDDEN_ROUTE = 'pages/sell/index'

export default function CustomTabBar() {
  const [active, setActive] = useState<TabKey>(() => currentTabKey())
  const [dot, setDot] = useState(false)
  const { status: authStatus, user } = useAuth()
  /** 消息页发布的未读快照（见 `features/chat/unread.ts`）；没进过消息页时为 null */
  const unread = useUnreadSnapshot()

  /** 当前账号 id（已登录时非空），effect 依赖它而不是整个 user 对象 */
  const userId = user?.id ?? null

  /**
   * 演示 / 开发构建（本地没有后端）的红点兜底。排除系统会话 —— 它的未读由「通知」
   * 承载，两边都算会重复计。
   *
   * 真实构建下是 `undefined`：未读数只能来自真实接口，读不到就是「不知道」，
   * 不能用 fixture 先亮一颗点进去什么都没有的幽灵红点。兜底由这里注入而不是
   * `features/chat/unread` 内判断构建开关 —— store 不该知道 fixture 的存在。
   */
  const demoUnread = useMemo(
    () =>
      MOCK_FALLBACK_ENABLED
        ? () => ({
            conversations: conversations()
              .filter((item) => item.kind !== 'system')
              .reduce((sum, item) => sum + item.unreadCount, 0),
            notifications: unreadNotificationCount(),
          })
        : undefined,
    [],
  )

  /**
   * 冷启动补快照（#129 review P1；#89 收口会话未读那一分量）。
   *
   * 底栏在每个 Tab 页都渲染，用户可能一次都不进消息页 —— 那时没有任何人发布快照。
   * 这里在「已登录 + 本次账号还没有快照」时补一次真实数据：
   * `GET /notifications/unread-count` 与 `GET /conversations/unread-count` 聚合
   * （`hydrateUnread` 内部按账号去重，多 Tab 实例只打一次）。
   *
   * 会话未读此前无论哪条路径都来自 fixture（#89 明写的既有债），于是底栏那颗点
   * 与「是否真的还有未读」毫无关系：通知未读为 0、接口失败时它照样亮，也从不随已读
   * 熄灭。现在两项都是真值，真实接口失败即「不知道」。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !userId) return
    hydrateUnread(userId, demoUnread)
  }, [authStatus, userId, demoUnread])

  /**
   * 返回前台时强制重取一次未读（#67 第三步）。
   *
   * 上面那条冷启动路径只在「还没有本次账号的快照」时才取数，所以小程序退到后台待一会儿
   * 再回来时，底栏会一直停在离开前的数字上 —— 这期间对方发来的消息它一无所知。
   *
   * 登录态走 ref 读最新值：`onAppShow` 只注册一次，直接闭包会拿到旧的 `userId`
   * （换号后仍替上一个账号取数）。`offAppShow` 必须在清理时调用，否则每次重挂
   * 底栏都会多一个监听器，一次前台事件打多次请求。
   */
  const refreshRef = useRef<() => void>(() => undefined)
  refreshRef.current = () => {
    if (authStatus === 'authed' && userId) refreshUnread(userId, demoUnread)
  }
  useEffect(() => {
    const onShow = () => refreshRef.current()
    Taro.onAppShow(onShow)
    return () => {
      Taro.offAppShow(onShow)
    }
  }, [])

  useEffect(() => {
    // 未登录不亮红点：未读数只能来自已登录账号，匿名时亮起等于在「我的」登录引导卡上
    // 展示别人的未读。
    if (authStatus !== 'authed' || !userId) {
      setDot(false)
      return
    }
    // 未读消息 + 未读通知的合计，决定消息 tab 的小红点。
    // 优先用本次账号的快照 —— 页内「进会话 / 看过通知」清掉的未读，红点同步消除。
    // 快照按账号校验：Chat 页实例被销毁（守卫 reLaunch 兜底重开整栈）时没人清快照，
    // 不带归属校验就会拿上一个账号的已读视角熄掉新账号的红点。
    //
    // 判定走 `badgeShouldLight`（纯函数、有用例）：任何一项为 `null`（「不知道」：
    // 列表未就绪 / 加载失败 / 真实接口不可达）时**不下「没有未读」的结论、保持上一帧** ——
    // 否则一颗本来亮着的点会莫名熄灭，而用户其实还有未读。
    if (unread && unread.ownerId === userId) {
      setDot(
        badgeShouldLight({
          conversations: unread.conversations,
          notifications: unread.notifications,
          previous: dot,
        }),
      )
      return
    }
    // 快照还没到位（补请求在途）。演示 / 开发构建（本地没有后端）维持 fixture 现算
    // 口径，真实构建保持上一帧 —— 等 `hydrateUnread` 的真实结果落地再决定，
    // 不能用 fixture 先亮一颗再说，也不能因为「还没到」就把已知的红点熄掉。
    if (!demoUnread) return
    const fallback = demoUnread()
    setDot(fallback.conversations + fallback.notifications > 0)
  }, [authStatus, userId, unread, demoUnread, dot])

  // 切换 Tab 后组件会重新渲染，这里同步一次高亮项
  useEffect(() => {
    setActive(currentTabKey())
  }, [])

  const go = (item: TabItem) => {
    if (item.key === active) return
    setActive(item.key)
    void Taro.switchTab({ url: item.path }).catch(() => undefined)
  }

  // 早退必须写在所有 hook 之后：hook 数量不能随路由变化
  if (currentRoute().includes(HIDDEN_ROUTE)) return null

  return (
    <View className="tabbar">
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
              {item.key === 'chat' && dot ? <View className="tabbar__dot" /> : null}
            </View>
            <Text className="tabbar__label">{item.label}</Text>
          </View>
        )
      })}
    </View>
  )
}
