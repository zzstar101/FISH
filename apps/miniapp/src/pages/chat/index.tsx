import type { ConversationDto } from '@fish/contracts/chat/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePageScroll } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchConversationUnreadCount, markConversationRead } from '@/features/chat/api'
import { clearUnread, publishUnread } from '@/features/chat/unread'
import { loadConversations, loadNotifications, markNotificationsRead } from '@/features/fetchers'
import type { MockNotification } from '@/mock/types'
import {
  badgeText,
  chatListState,
  conversationTimeLabel,
  previewOf,
  refreshConversationWindow,
} from './list-view'
import './index.scss'

/**
 * 会话 / 通知页（#89：从 fixture 改为真实 `GET /conversations`）。
 *
 * 筛选只剩「全部」+「通知」两档。原「交易 / 许愿」两档与「鱼小应小助手」系统会话行
 * 已删除：契约的 `ConversationDto` **没有**分类字段、也没有系统会话这个概念
 * （会话严格是 (商品, 买家×卖家) 一对一），客户端无从派生 —— 留着就是在发明语义。
 * 「通知」本来就是独立于会话的真实数据（#23/#129），不需要一行假会话当入口。
 *
 * 同理删掉了契约里不存在的展示件：认证徽章（`conversationUserSchema` 无 `authStatus`）、
 * 状态胶囊（无 `tag`）。会话行的相对时间由 `lastMessageAt` 现算（见 `./list-view`）。
 */

/** 1版稿筛选纯文字 Tab（顺序：全部 / 通知；「通知」页内直显通知列表） */
type ChatFilter = 'all' | 'system'

const FILTERS: { key: ChatFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '通知' },
]

/**
 * 通知的语气 → 图标（原 `pages/notifications` 的映射随页面并入）。文案与跳转目标
 * 不在页面里拼：契约只存 `type` + `payload`，组装在数据层（`mock/api.ts` 的
 * `decorateNotification`，与 web 端同口径），这里只负责「把 tone 映射成一张图」。
 */
const TONE_ICON: Record<MockNotification['tone'], string> = {
  mint: ICONS.heartOn,
  warn: ICONS.safeAccent,
}

/**
 * 通知条目的相对时间。fixture 的 `createdAt` 固定在 2026-09-14，因此以「现在」
 * 为基准算差值，而不是渲染 mock 里的绝对时间。
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

/**
 * 回到顶部钮的出现阈值：1版稿 .totop 滚过 380pt 后出现。
 * `usePageScroll` 的单位是逻辑 px（= 稿的 pt），**不是** scss 里的 rpx，不 ×2。
 */
const TOTOP_THRESHOLD = 380

export default function Chat() {
  // 消息列表需要登录（GET /conversations）；Tab 页只能用 navigateTo 跳登录页
  const authStatus = useAuthGuard({ tab: true })
  /** 当前账号身份：Tab 页实例跨登录态存活，跨账号重置本地状态要用它（见下） */
  const { user: authedUser } = useAuth()
  const [items, setItems] = useState<ConversationDto[]>([])
  /** 会话列表是否已经拿到过一次结果（成功或失败都算）；决定「加载态」还是「空态」 */
  const [ready, setReady] = useState(false)
  /** 真实接口失败且没有回退 mock（生产口径）→ 错误态 + 重试，而不是空态 */
  const [failed, setFailed] = useState(false)
  /** 更早一页会话的游标；null = 已到最后一页 */
  const [listNextCursor, setListNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 加载更多失败：只在尾部提示重试，不推翻已经看到的列表 */
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  /**
   * 服务端聚合的会话未读总数（`GET /conversations/unread-count`，#67）。
   *
   * 底栏那颗点要的是**全部**会话的和，而这里只加载了第一页 —— 所以不能对 `items`
   * 求和（会话超过一页时底栏会比真实值小，验收②就是这个场景）。`null` = 还没拿到 /
   * 请求失败，发布处退回本页求和（同一屏的真实值，是下界），但绝不发 0。
   */
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null)
  const [filter, setFilter] = useState<ChatFilter>('all')
  const [showTop, setShowTop] = useState(false)

  /** 通知列表（原独立通知页的数据与状态机随页面并入，加载口径不变） */
  const [notifs, setNotifs] = useState<MockNotification[]>([])
  const [notifsReady, setNotifsReady] = useState(false)
  /** 真实接口失败且没有回退 mock（生产口径）：「通知」tab 显示错误态而不是空态 */
  const [notifsFailed, setNotifsFailed] = useState(false)
  /**
   * 通知的已读口径：**切进「通知」tab 即视为看过**（Owner 拍板），未读角标随之清零，
   * 同时把当前已加载的未读条目逐条真实标记已读（声明式 effect，见下方「已读回写」）——
   * 服务端与本地同源后，重进页面 / 重启未读不再复活。
   * 原「全部已读」按钮因此没有存在的必要（后端本就没有 mark-all-read 端点）。
   */
  const [notifsViewed, setNotifsViewed] = useState(false)

  /**
   * 加载代次：并发加载（快速换账号 / 连点重试）时只有最后一次的响应落地。
   *
   * 会话与通知各有自己的代次：两者会同时发起，共用一个代次的话后发的那次会把
   * 先发的响应判成过期丢掉 —— 表现为「列表一直在加载中」。
   */
  const listEpoch = useRef(0)
  const notifEpoch = useRef(0)
  /**
   * 未读总数的代次：与上面两条分开。三条请求会同时飞（整页重载 + 通知列表 +
   * 未读聚合），共用一个代次的话后发的那次会把先到的响应判成过期丢掉。
   */
  const unreadEpoch = useRef(0)
  /**
   * 屏幕上已经加载出来的会话条数（渲染期同步）：从会话页返回时按它决定「重取几页」，
   * 才能既刷新内容、又留住分页深度（见 `refreshConversations`）。
   *
   * 走 ref 而不是直接闭包 `items`：`useDidShow` 的回调只注册一次，闭包会读到旧值
   * （与下方 `authedRef` 同一原因）。
   */
  const loadedCountRef = useRef(0)

  /**
   * 身份切换时的**渲染期重置**（adjust-state-during-render，React 官方推荐的
   * 「存上一帧信息」写法）：Tab 页实例跨登录态存活，`filter` / `items` / `notifs` /
   * `notifsViewed` 都是上一个账号的视角，必须在**同一个 commit 内**换成空值。
   * 写成 effect 里 setState 不行 —— 那要到下一帧才生效，兄弟 effect
   * （发布快照 / 已读回写）在本帧仍读到旧值：轻则把上个账号的已读视角发进全局
   * 快照（新账号的红点被误熄），重则拿新账号的 cookie 去 POST 上个账号的通知 id。
   */
  const identity = authedUser?.id ?? null
  const [prevIdentity, setPrevIdentity] = useState<string | null>(identity)
  if (prevIdentity !== identity) {
    setPrevIdentity(identity)
    // 在途响应（列表 / 已读回写）随身份一起作废：自增放在这里（渲染期，同步），
    // 不能放进 effect —— 那之间夹着微任务窗口，上一个账号的响应会写进刚清空的 state
    listEpoch.current += 1
    notifEpoch.current += 1
    unreadEpoch.current += 1
    setFilter('all')
    setItems([])
    setReady(false)
    setFailed(false)
    setListNextCursor(null)
    setLoadingMore(false)
    setLoadMoreFailed(false)
    setUnreadTotal(null)
    setNotifs([])
    setNotifsReady(false)
    setNotifsFailed(false)
    setNotifsViewed(false)
  }
  // 每帧把已加载条数同步给 ref（见上方注释）：返回刷新按它决定重取几页
  loadedCountRef.current = items.length

  /**
   * 会话列表加载。进页、换账号与错误态重试都走这里。
   *
   * 失败即清屏并进错误态（与首页 `applyLoadResult` 同一口径）：把上一批会话留在
   * 屏幕上会让人以为「刷新过了，就这几条」。
   *
   * 从会话页返回**不走这里**（那会把列表打回第一页）——见 `refreshConversations`。
   */
  const reloadConversations = useCallback(() => {
    const epoch = ++listEpoch.current
    const unreadToken = ++unreadEpoch.current
    setLoadingMore(false)
    // 整页重载必须把「加载更多」的失败标记一起清掉：否则一次失败之后，任何一次
    // 成功的重载（useDidShow 从会话页返回 / 错误态重试）都会继续在尾部报一句
    // 「更早的会话没加载出来」，而那一次翻页根本没发生过。
    setLoadMoreFailed(false)
    /**
     * 未读总数走服务端聚合（#67），与列表**并行**取。
     *
     * 与列表同生共死：进页、从会话页返回（`useDidShow`，即「已读变化后」）、错误态
     * 重试都经由这里，所以放在同一个函数里，不会出现「列表刷新了、底栏还停在旧数」。
     * 失败只把结果置 `null`（「不知道」），发布处退回本页求和 —— 不能清成 0。
     */
    void fetchConversationUnreadCount()
      .then((total) => {
        if (unreadToken !== unreadEpoch.current) return
        setUnreadTotal(total)
      })
      .catch((error) => {
        console.warn('[miniapp] 未读总数加载异常', error)
        if (unreadToken !== unreadEpoch.current) return
        setUnreadTotal(null)
      })
    void loadConversations()
      .then(({ items: list, nextCursor: cursor, failed: nextFailed }) => {
        if (epoch !== listEpoch.current) return
        setItems(list)
        setListNextCursor(cursor)
        setFailed(nextFailed)
        setReady(true)
      })
      .catch((error) => {
        // 取数层自己吞了接口失败，这里兜的是「回退 mock 的动态 import 也失败」：
        // 少了这个 catch，ready 会永远为 false —— 页面既没有错误态、也没有重试钮
        console.warn('[miniapp] 会话列表加载异常', error)
        if (epoch !== listEpoch.current) return
        setItems([])
        setListNextCursor(null)
        setFailed(true)
        setReady(true)
      })
  }, [])

  /**
   * 从会话页返回时的刷新（#67 第三步）：**重取已经加载过的那几页**，而不是打回第一页。
   *
   * `reloadConversations` 是整页重载 —— 它把列表换回第一页，用户刚翻到的位置与滚动
   * 深度一起丢掉。这里按当前分页深度重取同一个窗口（`refreshConversationWindow`，
   * 纯函数 + 用例），成功时**原位替换**：刚聊完的那条带着新的 `lastMessage` / 清零的
   * 角标回到它该在的位置，更早的页面还在原处。
   *
   * 未读总数与 `reloadConversations` 同口径、并行取：底栏要的是**全部**会话的和，
   * 「已读变化后更新」靠它，不靠列表本身。
   *
   * 失败口径见 `refreshConversationWindow` 的三种结局：第一页就没拿到 → 清屏进错误态
   * （沿用「不允许把上一批会话留在屏幕上冒充刷新结果」）；后续页失败 → 保留已经刷新的
   * 前几页，只把尾部标成「更早的会话没加载出来」，不推翻已经看到的列表。
   */
  const refreshConversations = useCallback(() => {
    const epoch = ++listEpoch.current
    const unreadToken = ++unreadEpoch.current
    setLoadingMore(false)
    setLoadMoreFailed(false)
    void fetchConversationUnreadCount()
      .then((total) => {
        if (unreadToken !== unreadEpoch.current) return
        setUnreadTotal(total)
      })
      .catch((error) => {
        console.warn('[miniapp] 未读总数加载异常', error)
        if (unreadToken !== unreadEpoch.current) return
        setUnreadTotal(null)
      })
    void refreshConversationWindow((cursor) => loadConversations(cursor), loadedCountRef.current)
      .then((refreshed) => {
        if (epoch !== listEpoch.current) return
        if (refreshed.kind === 'first-page-failed') {
          setItems([])
          setListNextCursor(null)
          setFailed(true)
          setReady(true)
          return
        }
        setItems(refreshed.items)
        setListNextCursor(refreshed.nextCursor)
        // 前几页已经刷新成功：只把尾部标成失败，不推翻刷到的内容
        setLoadMoreFailed(refreshed.kind === 'tail-failed')
        setFailed(false)
        setReady(true)
      })
      .catch((error) => {
        // 与 reloadConversations 同一兜法：取数层的动态 import 失败会让 promise 真的 reject
        console.warn('[miniapp] 会话列表刷新异常', error)
        if (epoch !== listEpoch.current) return
        setItems([])
        setListNextCursor(null)
        setFailed(true)
        setReady(true)
      })
  }, [])

  /**
   * 「加载更多会话」：契约按 `lastMessageAt` 降序 + 游标分页，游标原样回传。
   *
   * 不做就只是「最近 50 条」静默截断 —— 用户没有任何办法翻到更早的会话。
   * 失败只把这一页标成失败（`loadMoreFailed`），**不动**已经看到的列表。
   */
  const loadMoreConversations = () => {
    if (!listNextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreFailed(false)
    const epoch = listEpoch.current
    void loadConversations(listNextCursor)
      .then((page) => {
        if (epoch !== listEpoch.current) return
        if (page.failed) {
          setLoadMoreFailed(true)
          return
        }
        /**
         * 按 id 去重：翻页期间消息会把会话重新排序，被顶到后一页的会话可能已经
         * 在列表里（服务端用的是严格 `<` 键集比较，跨页本身不会重复返回同一条）。
         */
        setItems((prev) => {
          const seen = new Set(prev.map((item) => item.id))
          return [...prev, ...page.items.filter((item) => !seen.has(item.id))]
        })
        setListNextCursor(page.nextCursor)
      })
      .catch((error) => {
        // 与 reloadConversations / loadNotifs 同一兜法：取数层的动态 import 失败
        // 会让 promise 真的 reject，这里必须接住并置失败态，不能留 unhandled rejection
        console.warn('[miniapp] 加载更多会话异常', error)
        if (epoch !== listEpoch.current) return
        setLoadMoreFailed(true)
      })
      .finally(() => setLoadingMore(false))
  }

  /** 通知列表加载：与原独立通知页同一份数据层（真接口失败回退 mock），重试也走这里 */
  const loadNotifs = useCallback(() => {
    const epoch = ++notifEpoch.current
    void loadNotifications()
      .then(({ items: list, failed: nextFailed }) => {
        // 并发加载（快速换账号 / 连点重试）时旧响应后到，不能覆盖新账号的列表
        if (epoch !== notifEpoch.current) return
        setNotifs(list)
        setNotifsFailed(nextFailed)
        setNotifsReady(true)
      })
      .catch((error) => {
        // 取数层自己吞了接口失败，这里兜的是「回退 mock 的动态 import 也失败」：
        // 少了这个 catch，notifsReady 会永远为 false —— 通知 tab 既没有错误态、
        // 也没有重试钮，看起来像「一直没加载完」
        console.warn('[miniapp] 通知列表加载异常', error)
        if (epoch !== notifEpoch.current) return
        setNotifsFailed(true)
        setNotifsReady(true)
      })
  }, [])

  /**
   * 登录态变化的取数：登录 / 换账号后重拉会话与通知，并**先丢弃共享未读快照**。
   *
   * 丢弃放在每次变化的最前面（不只是未登录）：`authed(A) → authed(B)`（登录页
   * 兜底失败后直接换账号）也走得到，那时若不丢，上个账号的已读视角会一直替新账号
   * 熄底栏红点；丢弃后由新账号的列表加载重新发布。
   *
   * 状态重置**不在这里**（见上方渲染期重置）：effect 里 setState 下一帧才生效，
   * 兄弟 effect 会先读到旧值。
   */
  useEffect(() => {
    clearUnread()
    if (authStatus !== 'authed' || !authedUser) return
    reloadConversations()
    loadNotifs()
  }, [authStatus, authedUser, reloadConversations, loadNotifs])

  /**
   * 从会话页返回时刷新：那边进页会把自己的未读清零，列表要跟着更新，
   * 否则刚聊完回来角标还挂在原处。
   *
   * 走 `refreshConversations`（重取已加载的那几页）而不是 `reloadConversations`
   * （整页重载回第一页）：返回是最高频的一次刷新，把用户刚翻到的位置打回第一页
   * 是明显的体验倒退，而这次刷新的目的只是让内容变新，不是换一批数据。
   *
   * 首次 show 跳过 —— 那次由上面的登录态 effect 负责（冷启动时 `authStatus` 可能
   * 还是 `unknown`，由它负责时点才准确），不跳过就会刚进页打两次。
   * `authStatus` 走 ref 读最新值：`useDidShow` 的回调注册一次，直接闭包会读到旧状态。
   */
  const skipFirstShow = useRef(true)
  const authedRef = useRef(false)
  authedRef.current = authStatus === 'authed'
  useDidShow(() => {
    if (skipFirstShow.current) {
      skipFirstShow.current = false
      return
    }
    if (!authedRef.current) return
    refreshConversations()
  })

  /** 1版稿 .totop：滚过一屏半后浮现 */
  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > TOTOP_THRESHOLD))

  /**
   * 通知未读数（#23 `GET /notifications/unread-count` 的语义）：切进「通知」tab 即清零。
   *
   * 列表**未就绪 / 加载失败**时是「不知道」——记 0（不显示通知侧的未读），不拿 mock
   * fixture 计数顶替：那会与底栏的快照口径分叉（底栏对这些状态按「无已知未读」算），
   * 也会把「不知道」画成一个具体的数字。
   */
  const unreadNotifications =
    notifsReady && !notifsFailed
      ? notifsViewed
        ? 0
        : notifs.filter((item) => item.readAt === null).length
      : 0

  /**
   * 会话区的渲染形态。判定抽在 `./list-view` 里（纯函数 + 用例）：这里只把三个
   * 事实传进去 —— 把「没读到」显示成「你没有会话」是这一块最容易犯的错。
   */
  const state = chatListState({ ready, failed, itemCount: items.length })

  /** 未读会话（「全部已读」与底栏红点的操作对象） */
  const unreadItems = useMemo(() => items.filter((item) => item.unreadCount > 0), [items])

  /**
   * 本页会话的未读条数和：**只是回退值**。底栏的会话分量以 `unreadTotal`
   * （服务端聚合，覆盖全部会话）为准。真实数据里没有「系统会话」（契约的会话
   * 就是买卖双方一对一），所以直接求和，不需要排除项。
   *
   * 留着它是因为两种情况下它仍然有用：聚合请求失败（弱网）与演示构建
   * （本地没有后端，列表来自 fixture）。它是下界，不是「不知道当成 0」。
   */
  const conversationUnread = useMemo(
    () => items.reduce((sum, item) => sum + item.unreadCount, 0),
    [items],
  )

  /**
   * 未读快照发布：底栏「消息」红点与页内角标同源（见 `features/chat/unread.ts`）。
   *
   * `conversations` 与 `notifications` 在「不知道」（列表未就绪 / 加载失败）时都发
   * `null`，底栏按「无已知未读」算 —— 与页内同口径。会话这一项尤其不要发 0：
   * 没读到却发 0 会把上一份正确的快照覆盖掉，用户明明还有未读，那颗点却熄了。
   * 未登录不发（登出 / 换账号的清空在身份 effect）。
   *
   * 会话分量优先用服务端聚合（`unreadTotal`，覆盖全部会话），拿不到才退回本页求和
   * —— 本页只加载了第一页，求和是下界（#67 验收②）。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !identity) return
    publishUnread({
      ownerId: identity,
      conversations: ready && !failed ? (unreadTotal ?? conversationUnread) : null,
      notifications: notifsReady && !notifsFailed ? unreadNotifications : null,
    })
  }, [
    authStatus,
    identity,
    ready,
    failed,
    notifsReady,
    notifsFailed,
    unreadTotal,
    conversationUnread,
    unreadNotifications,
  ])

  /**
   * 已读回写是**声明式**的：只要「通知」tab 被看过（`notifsViewed`，粘性状态）
   * 且列表已就绪，就把当前已加载的未读条目逐条真实标记已读
   * （幂等 `POST /notifications/:id/read`）。门禁用 `notifsViewed` 而**不是**
   * `filter === 'system'`：弱网下「点进 tab → 列表还没到就切回其它 tab」的列表
   * 到达时已不在通知 tab，用当前 tab 当门禁就会一条都不标，而角标已按已读清零 ——
   * 页内与服务端分叉，重进页面未读"复活"。
   *
   * 只标已加载的条目（契约无 mark-all-read）。门禁必须含 `authed`：登出后才
   * resolve 的迟到列表不能以匿名身份发 N 个必然 401 的 POST。回写结果同样要过
   * 代次守卫：换账号 / 列表重载之后迟到的响应不得写进当前列表（mock / 演示构建里
   * 各账号的 fixture id 相同，串号会确定性地发生）。成功的条目把本地 `readAt`
   * 补上；失败的保持未读 —— 本批只要有一条成功，列表变化会立刻再跑一轮
   * （待标条数单调递减，有界），整批失败则等列表下次变化（错误态的重试钮成功 /
   * 页面实例重建）再试。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !notifsViewed || !notifsReady) return
    const pending = notifs.filter((item) => item.readAt === null)
    if (pending.length === 0) return
    const epoch = notifEpoch.current
    void markNotificationsRead(pending).then((markedIds) => {
      if (epoch !== notifEpoch.current || markedIds.size === 0) return
      setNotifs((prev) =>
        prev.map((item) =>
          item.readAt === null && markedIds.has(item.id)
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      )
    })
  }, [authStatus, notifsViewed, notifs, notifsReady])

  /**
   * 「全部已读」= 逐条真实 `POST /conversations/:id/read`（契约没有 mark-all-read 端点）。
   *
   * 此前它只改本地 `readIds`：服务端读位没动，重进页面未读全"复活"。现在只有
   * **真的成功了**才清本地角标；部分失败如实报数，不假称已全部读完。
   */
  const markAllRead = () => {
    if (unreadItems.length === 0) {
      void Taro.showToast({ title: '没有未读会话', icon: 'none' })
      return
    }
    const epoch = listEpoch.current
    void Promise.allSettled(unreadItems.map((item) => markConversationRead(item.id))).then(
      (results) => {
        if (epoch !== listEpoch.current) return
        const done = new Set(
          unreadItems
            .filter((_, index) => results[index]?.status === 'fulfilled')
            .map((item) => item.id),
        )
        if (done.size > 0) {
          setItems((prev) =>
            prev.map((item) => (done.has(item.id) ? { ...item, unreadCount: 0 } : item)),
          )
        }
        const missed = unreadItems.length - done.size
        void Taro.showToast({
          title: missed === 0 ? '已全部标为已读' : `有 ${missed} 个会话标记失败，请重试`,
          icon: 'none',
        })
      },
    )
  }

  /**
   * 点进会话：**只负责跳转，不在这里发 `POST /conversations/:id/read`**。
   *
   * 已读由会话页进页时落地 —— 那一页才是「用户真的看到了消息」的地方。列表页提前
   * 推读位，会在用户只是路过、甚至会话页还没加载出来时就把未读清掉；未读是服务端
   * 权威派生量，不该由一次跳转冒充已读。从会话页返回时 `useDidShow` 会重拉，
   * 角标随服务端的真实未读更新。
   */
  const openConversation = (id: string) => {
    void Taro.navigateTo({ url: `/pages/conversation/index?id=${id}` })
  }

  /** tab 切换：进「通知」tab 即视为已读（角标清零；真实 mark-read 由上方 effect 声明式补标） */
  const chooseFilter = (key: ChatFilter) => {
    setFilter(key)
    if (key === 'system') setNotifsViewed(true)
  }

  /** 通知条目点击：只负责按 `target` 跳转（清零是 tab 级的，见 `chooseFilter`） */
  const openNotif = (item: MockNotification) => {
    if (item.target?.kind === 'listing') {
      void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.target.listingId}` })
      return
    }
    if (item.target?.kind === 'wish') void Taro.switchTab({ url: '/pages/wish/index' })
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /**
   * 未登录 / 登录态还没恢复完之前**不渲染列表**。
   *
   * 守卫只负责跳转，跳转可能失败（页面栈、Tab 页限制）；不拦渲染的话，未登录用户
   * 会看到一个空列表，被读成「你没有会话」而不是「你还没登录」。
   */
  if (authStatus !== 'authed') {
    // `unknown`（冷启动的 `GET /me` 还没回来）不能说「登录后查看消息」——
    // 已登录用户会先看到一句与自己状态相反的文案（见 `guard.ts` 文件头第 1 条）
    return (
      <View className="chat">
        <View className="chat__bg" />
        <TopBar variant="glass" spacer title="消" titleEm="息" />
        {authStatus === 'unknown' ? (
          <View className="chat__empty">
            <Text className="chat__empty-title">正在恢复登录状态…</Text>
          </View>
        ) : (
          <View className="chat__empty">
            <Text className="chat__empty-title">登录后查看消息</Text>
            <Text className="chat__empty-text">和同学聊一聊、确认面交都在这里</Text>
          </View>
        )}
      </View>
    )
  }

  /** 会话行的时间用同一个「现在」：每行各取一次会算出互相矛盾的相对时间 */
  const now = Date.now()

  return (
    <View className="chat">
      <View className="chat__bg" />

      {/*
        吸顶玻璃栏：主行「消息」+ 副行筛选 Tab（1版稿 .filterbar）在同一块玻璃里，
        会话列表从底下滚过。「全部已读」小圆钮在副行右端 —— 食盒图标有两版：
        有未读走主题色，全部已读转灰。
      */}
      <TopBar
        variant="glass"
        spacer
        title="消"
        titleEm="息"
        below={
          <View className="chat__filters">
            <View className="chat__tabs">
              {FILTERS.map((item) => {
                const on = item.key === filter
                /** 各 tab 的数字：「全部」挂会话总数；「通知」挂通知未读数（#23，切进 tab 即清零） */
                const tabBadge = item.key === 'all' ? items.length : unreadNotifications
                return (
                  <View
                    key={item.key}
                    // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child）
                    className={`chat__tab chat__tab--${item.key}${on ? ' is-on' : ''}`}
                    onClick={() => chooseFilter(item.key)}
                  >
                    <Text>{item.label}</Text>
                    {tabBadge > 0 ? (
                      <Text className="chat__tab-n num">{badgeText(tabBadge)}</Text>
                    ) : null}
                  </View>
                )
              })}
            </View>

            <View className="chat__readall" onClick={markAllRead}>
              <Image
                className="chat__readall-ic"
                src={unreadItems.length === 0 ? ICONS.readallMuted : ICONS.readallAccent}
                mode="aspectFit"
              />
            </View>
          </View>
        }
      />
      {/* 副行占位：筛选行高 28（上衬）+ 68（Tab 高）= 96px，组件的 spacer 只含主行 */}
      <View className="chat__header-gap" />

      {/*
        会话列表（1版稿 .list）。「通知」tab 不再走会话列表：原独立通知页的列表
        直接渲染在这里（页面已删）；「全部」tab 渲染真实会话行。
      */}
      <View className="chat__list">
        {filter === 'system' ? (
          <View className="notif__list">
            {notifs.map((item) => (
              <View key={item.id} className="notif__item" onClick={() => openNotif(item)}>
                <View className="notif__ic">
                  <Image className="notif__ic-img" src={TONE_ICON[item.tone]} mode="aspectFit" />
                </View>
                <View className="notif__body">
                  <Text className="notif__body-title">{item.title}</Text>
                  <Text className="notif__tm num">{relativeTime(item.createdAt)}</Text>
                  <Text className="notif__text">{item.description}</Text>
                </View>
              </View>
            ))}

            {/* 失败态优先于空态：没加载出来不等于没有通知；空态也要等结果，
                避免请求途中闪过一句「还没有通知」 */}
            {notifsFailed ? (
              <LoadError onRetry={loadNotifs} />
            ) : notifsReady && notifs.length === 0 ? (
              <EmptyState
                title="还没有通知"
                text="愿望匹配上闲置、交易有进展时会出现在这里"
                icon={ICONS.bellInk}
              />
            ) : null}
          </View>
        ) : state === 'error' ? (
          /* 失败态优先于一切：没读到不等于没有会话 */
          <LoadError onRetry={reloadConversations} />
        ) : state === 'loading' ? (
          <View className="chat__empty">
            <Text className="chat__empty-title">正在加载会话…</Text>
          </View>
        ) : state === 'empty' ? (
          <View className="chat__empty">
            <Text className="chat__empty-title">这里还没有会话</Text>
            <Text className="chat__empty-text">在商品详情点「我想要」就能开聊</Text>
          </View>
        ) : (
          <>
            {items.map((item) => {
              /** 直接消费契约 `ConversationDto.counterpart`，不拿 id 自己查表 */
              const user = item.counterpart
              const unread = item.unreadCount

              return (
                <View
                  key={item.id}
                  className={`chat__conv${unread > 0 ? ' is-unread' : ''}`}
                  onClick={() => openConversation(item.id)}
                >
                  {/* 头像 + 未读角标：角标要浮到头像外，所以裁剪只落在 .chat__ava 上 */}
                  <View className="chat__ava-wrap">
                    <View className="chat__ava">
                      {/* 契约允许 avatarUrl 为 null（users.avatar_url 可空）；空串即不渲染图 */}
                      <Image
                        className="chat__ava-img"
                        src={user.avatarUrl ?? ''}
                        mode="aspectFill"
                      />
                    </View>
                    {unread > 0 ? <Text className="chat__bdg num">{badgeText(unread)}</Text> : null}
                  </View>

                  <View className="chat__corp">
                    <View className="chat__corp-top">
                      <Text className="chat__nm-tx">{user.nickname}</Text>
                    </View>
                    <Text className="chat__msg">{previewOf(item)}</Text>
                    {/* 1版稿时间在第三行（消息下方），不再是行右上角 */}
                    <Text className="chat__tm num">
                      {conversationTimeLabel(item.lastMessageAt, now)}
                    </Text>
                  </View>

                  {/* 右侧商品缩略图（1版稿 .thumb）：契约 `listing.coverUrl` */}
                  <View className="chat__thumb">
                    {item.listing.coverUrl ? (
                      <Image
                        className="chat__thumb-img"
                        src={item.listing.coverUrl}
                        mode="aspectFill"
                      />
                    ) : (
                      <Image className="chat__thumb-ic" src={ICONS.imageMuted} mode="aspectFit" />
                    )}
                  </View>
                </View>
              )
            })}

            {/*
              更早的会话：契约按 `lastMessageAt` 降序 + 游标分页。没有这个入口，
              会话多于 50 条的用户就只能看到最近 50 条，且没有任何翻页办法。
              失败只在尾部提示重试，不推翻已经看到的列表。
            */}
            {listNextCursor || loadMoreFailed ? (
              <View className="chat__more">
                {loadMoreFailed ? (
                  <View className="chat__more-btn" onClick={loadMoreConversations}>
                    <Text>更早的会话没加载出来 · 重试</Text>
                  </View>
                ) : (
                  <View className="chat__more-btn" onClick={loadMoreConversations}>
                    <Text>{loadingMore ? '正在加载…' : '加载更多会话'}</Text>
                  </View>
                )}
              </View>
            ) : null}
          </>
        )}
      </View>

      {/* 1版稿 .totop：滚过一屏半浮现，品牌色上箭头 */}
      <View className={`chat__totop${showTop ? ' is-show' : ''}`} onClick={backToTop}>
        <View className="chat__totop-arrow" />
      </View>
    </View>
  )
}
