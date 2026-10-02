import type { ConversationDto } from '@fish/contracts/chat/schema'
import type { TransactionDto, TransactionSystemEvent } from '@fish/contracts/transactions/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePageScroll } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import {
  fetchConversationUnreadCount,
  fetchMessagePage,
  markConversationRead,
} from '@/features/chat/api'
import {
  capsuleFor,
  lastEventOfMessages,
  needsProposalScan,
  transactionsByConversation,
} from '@/features/chat/capsule'
import { clearUnread, publishUnread } from '@/features/chat/unread'
import { loadConversations, loadNotifications, markNotificationsRead } from '@/features/fetchers'
import { fetchAllTransactions } from '@/features/transaction/api'
import { notifyTabbarRoute } from '@/lib/tabbar-sync'
import type { MockNotification } from '@/mock/types'
import { badgeText, chatListState, conversationTimeLabel, previewOf } from './list-view'
import './index.scss'

/**
 * 会话 / 通知页（#89：从 fixture 改为真实 `GET /conversations`）。
 *
 * 筛选只剩「全部」+「通知」两档。原「交易 / 许愿」两档与「鱼小应小助手」系统会话行
 * 已删除：契约的 `ConversationDto` **没有**分类字段、也没有系统会话这个概念
 * （会话严格是 (商品, 买家×卖家) 一对一），客户端无从派生 —— 留着就是在发明语义。
 * 「通知」本来就是独立于会话的真实数据（#23/#129），不需要一行假会话当入口。
 *
 * 同理删掉了契约里不存在的展示件：认证徽章（`conversationUserSchema` 无 `authStatus`）。
 * 状态胶囊（无 `tag`）后来由任务一按交易域恢复了，见 `features/chat/capsule.ts`。
 * 会话行的相对时间由 `lastMessageAt` 现算（见 `./list-view`）。
 */

/** 1版稿筛选纯文字 Tab（顺序：全部 / 通知；「通知」页内直显通知列表） */
type ChatFilter = 'all' | 'system'

const FILTERS: { key: ChatFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '通知' },
]

/**
 * 一次进页最多拉多少个会话的消息页来判提案（见 `scanProposals`）。
 *
 * 上限的推导：消息页请求只在「最近的会话里有人提案、且之后有人回过话」时才发，
 * 这类会话在首屏（50 条）里通常个位数；同时它挡住了最坏情形 —— 一个从没提案、
 * 只闲聊的账号，刷一次消息页不该发出 50 个请求。超出的会话按「不知道」处理
 * （不显示胶囊）。与「我的发布」的 `MAX_PROPOSAL_SCANS` 同一量级。
 */
const MAX_PROPOSAL_SCANS = 12

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
  /**
   * 会话未读**条数和**：底栏「消息」红点的会话分量（发布给 `features/chat/unread`）。
   *
   * 走专用端点 `GET /conversations/unread-count`（#291），不再对**本页**会话列表求和：
   * 列表只有第一页（契约上限 50 条），会话多于 50 且更早那批里还有未读时会漏计 ——
   * 红点时代只影响「亮不亮」，改成精确数字后就是用户可见的错误。
   *
   * `null` = 还不知道（未取到 / 接口失败）。**不发 0**：0 是「确定没有未读」这个
   * 具体结论，拿它顶替会把上一份正确的快照覆盖掉。
   */
  const [conversationUnread, setConversationUnread] = useState<number | null>(null)
  /** 更早一页会话的游标；null = 已到最后一页 */
  const [listNextCursor, setListNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 加载更多失败：只在尾部提示重试，不推翻已经看到的列表 */
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  const [filter, setFilter] = useState<ChatFilter>('all')
  const [showTop, setShowTop] = useState(false)

  /** 通知列表（原独立通知页的数据与状态机随页面并入，加载口径不变） */
  const [notifs, setNotifs] = useState<MockNotification[]>([])
  const [notifsReady, setNotifsReady] = useState(false)
  /** 真实接口失败且没有回退 mock（生产口径）：「通知」tab 显示错误态而不是空态 */
  const [notifsFailed, setNotifsFailed] = useState(false)
  /**
   * 交易行快照（#89 状态胶囊）：`conversationId → TransactionDto`，买卖双角色各取完
   * 一份合成。**失败静默降级成空映射（不显示胶囊）**，不打错误态 —— 胶囊是列表的
   * 增强信息，交易域挂了不该连会话都看不到。
   */
  const [txMap, setTxMap] = useState<Map<string, TransactionDto>>(new Map())
  /**
   * 提案扫描结果（#89）：`conversationId → 最后一个 tx.* 事件`。
   *
   * 只有 `needsProposalScan` 判为「光看 `lastMessage` 不够」的会话才在这里有条目：
   * 买家提过案、之后有人回了句话（TEXT / 媒体 / 非交易 SYSTEM），提案仍在等点头 ——
   * 只认 `lastMessage` 会让胶囊凭空消失（与「我的发布」的「待确认」段同一口径）。
   * 扫描有请求上限（`MAX_PROPOSAL_SCANS`）：超出的会话按「不知道」处理，不显示胶囊。
   */
  const [txSignals, setTxSignals] = useState<Map<string, TransactionSystemEvent | null>>(new Map())

  /**
   * 加载代次：并发加载（快速换账号 / 连点重试）时只有最后一次的响应落地。
   *
   * 会话与通知各有自己的代次：两者会同时发起，共用一个代次的话后发的那次会把
   * 先发的响应判成过期丢掉 —— 表现为「列表一直在加载中」。
   */
  const listEpoch = useRef(0)
  const notifEpoch = useRef(0)

  /**
   * 身份切换时的**渲染期重置**（adjust-state-during-render，React 官方推荐的
   * 「存上一帧信息」写法）：Tab 页实例跨登录态存活，`filter` / `items` / `notifs`
   * 都是上一个账号的视角，必须在**同一个 commit 内**换成空值。
   * 写成 effect 里 setState 不行 —— 那要到下一帧才生效，兄弟 effect
   * （发布快照）在本帧仍读到旧值：轻则把上个账号的已读视角发进全局
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
    setFilter('all')
    setItems([])
    setReady(false)
    setFailed(false)
    // 未读总数属于上一个账号：先记「不知道」，别让它的红点挂在新账号上
    setConversationUnread(null)
    setListNextCursor(null)
    setLoadingMore(false)
    setLoadMoreFailed(false)
    setNotifs([])
    setNotifsReady(false)
    setNotifsFailed(false)
    setTxMap(new Map())
    setTxSignals(new Map())
  }

  /**
   * 提案扫描（#89）：对「光看 `lastMessage` 判不出」的会话拉一页消息，取最后一个
   * `tx.*` 事件。**只在这批会话里扫，且有请求上限**——从会话页返回时每次都要跑，
   * 无上限地拉几百个会话的消息页会把返回路径拖成秒级。
   *
   * 结果按 `(会话 id, lastMessageAt)` 缓存：`lastMessageAt` 没动就说明这个会话没有
   * 新消息、结论不变，重复进页（切 Tab / 从会话页返回）不再发请求 —— 否则每次返回
   * 都要重拉十几个会话的消息页。有新消息时 `lastMessageAt` 必然变化（新消息会更新它），
   * 缓存自动失效。
   *
   * 失败与超限都按「不知道」处理（该会话不显示胶囊），不打断会话列表渲染 ——
   * 胶囊是列表的增强信息。`lastMessage` 已经是 `tx.*` 的会话零成本短路，不进扫描。
   */
  const proposalCache = useRef(
    new Map<string, { at: string; event: TransactionSystemEvent | null }>(),
  )
  const scanProposals = useCallback(
    async (list: ConversationDto[], txSnapshot: Map<string, TransactionDto>, epoch: number) => {
      const pending: string[] = []
      const found = new Map<string, TransactionSystemEvent | null>()
      for (const item of list) {
        if (pending.length >= MAX_PROPOSAL_SCANS) break
        if (!needsProposalScan(item, txSnapshot)) continue
        const cached = proposalCache.current.get(item.id)
        if (cached && cached.at === item.lastMessageAt) {
          found.set(item.id, cached.event)
          continue
        }
        pending.push(item.id)
      }
      if (pending.length === 0) {
        if (epoch === listEpoch.current) setTxSignals(found)
        return
      }
      const results = await Promise.allSettled(
        pending.map((id) => fetchMessagePage(id).then((page) => page.items)),
      )
      if (epoch !== listEpoch.current) return
      results.forEach((result, index) => {
        const id = pending[index]
        if (id === undefined) return
        // 单条读不到：按「不知道」处理（不显示胶囊），不把「读不到」当成「没有提案」
        const event = result.status === 'fulfilled' ? lastEventOfMessages(result.value) : null
        found.set(id, event)
        // 只在真的读到结果时写缓存；读失败下次仍要重试
        if (result.status === 'fulfilled') {
          const at = list.find((item) => item.id === id)?.lastMessageAt
          if (at !== undefined) proposalCache.current.set(id, { at, event })
        }
      })
      setTxSignals(found)
    },
    [],
  )

  /**
   * 会话未读总数（底栏红点的会话分量）。与列表**同一代次**守卫：换账号 / 重载之后
   * 迟到的响应不得落地 —— 否则上一个账号的未读会写进新账号的快照。
   *
   * 失败即记「不知道」（`null`），**不回退 fixture、不拿 0 冒充**（见 state 处的注释）。
   */
  const loadConversationUnread = useCallback((epoch: number) => {
    void fetchConversationUnreadCount()
      .then((count) => {
        if (epoch !== listEpoch.current) return
        setConversationUnread(count)
      })
      .catch((error) => {
        console.warn('[miniapp] 会话未读总数加载失败，底栏按「不知道」算', error)
        if (epoch !== listEpoch.current) return
        setConversationUnread(null)
      })
  }, [])

  /**
   * 会话列表加载。重试钮、进页、以及从会话页返回（`useDidShow`）都走这里。
   *
   * 失败即清屏并进错误态（与首页 `applyLoadResult` 同一口径）：把上一批会话留在
   * 屏幕上会让人以为「刷新过了，就这几条」。
   */
  const reloadConversations = useCallback(() => {
    const epoch = ++listEpoch.current
    // 未读总数与列表同轮刷新。它是**独立端点**的结果，与列表是否被截断到 50 条无关，
    // 也不等列表 —— 列表失败时底栏红点仍应有真值。
    loadConversationUnread(epoch)
    setLoadingMore(false)
    // 整页重载必须把「加载更多」的失败标记一起清掉：否则一次失败之后，任何一次
    // 成功的重载（useDidShow 从会话页返回 / 错误态重试）都会继续在尾部报一句
    // 「更早的会话没加载出来」，而那一次翻页根本没发生过。
    setLoadMoreFailed(false)
    // 交易快照与会话同一轮刷新（同一代次守卫）：从会话页返回时面交确认可能刚发生，
    // 胶囊必须跟着重算；「加载更多」不重拉（早前会话的交易在首屏快照里已就位）。
    const txLoaded = Promise.all([fetchAllTransactions('buyer'), fetchAllTransactions('seller')])
      .then(([buyer, seller]) => {
        if (epoch !== listEpoch.current) return null
        const map = transactionsByConversation(buyer.items, seller.items)
        setTxMap(map)
        /*
         * 列表被截断（翻页到 `MAX_PAGES` 上限，或服务端游标没前进）时，未取到的那部分
         * 会话**静默没有胶囊**。胶囊是增强信息、不报错，但要在控制台留痕 ——
         * 否则「几百笔交易之后的会话一律没有胶囊」会被当成胶囊功能坏了。
         */
        if (buyer.truncated || seller.truncated) {
          console.warn('[miniapp] 交易列表被截断，超出部分的会话不显示交易胶囊')
        }
        return map
      })
      .catch((error) => {
        console.warn('[miniapp] 交易快照加载失败，本屏不显示交易胶囊', error)
        if (epoch !== listEpoch.current) return null
        setTxMap(new Map())
        return new Map<string, TransactionDto>()
      })
    void loadConversations()
      .then(({ items: list, nextCursor: cursor, failed: nextFailed }) => {
        if (epoch !== listEpoch.current) return
        setItems(list)
        setListNextCursor(cursor)
        setFailed(nextFailed)
        setReady(true)
        // 提案扫描要等交易快照：有交易行的会话不必扫（状态机只看交易行）。
        void txLoaded.then((map) => {
          if (!map || epoch !== listEpoch.current) return
          void scanProposals(list, map, epoch)
        })
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
  }, [scanProposals, loadConversationUnread])

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
   * 从会话页返回时重拉：那边进页会把自己的未读清零，列表要跟着更新，
   * 否则刚聊完回来角标还挂在原处。
   *
   * 首次 show 跳过 —— 那次由上面的登录态 effect 负责（冷启动时 `authStatus` 可能
   * 还是 `unknown`，由它负责时点才准确），不跳过就会刚进页打两次。
   * `authStatus` 走 ref 读最新值：`useDidShow` 的回调注册一次，直接闭包会读到旧状态。
   */
  const skipFirstShow = useRef(true)
  const authedRef = useRef(false)
  authedRef.current = authStatus === 'authed'
  // 底栏选中态的真源是页面路径：本页 onShow 时广播一次（见 lib/tabbar-sync）
  useDidShow(notifyTabbarRoute)
  useDidShow(() => {
    if (skipFirstShow.current) {
      skipFirstShow.current = false
      return
    }
    if (!authedRef.current) return
    reloadConversations()
  })

  /** 1版稿 .totop：滚过一屏半后浮现（阈值随共享组件） */
  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  /**
   * 通知未读数（#23 `GET /notifications/unread-count` 的语义）。#431 任务二起
   * **逐条点击才已读**（见 `openNotif`）：进「通知」tab 不再整表清零，此数随
   * 逐条已读递减，页内胶囊与底栏徽标同步。
   *
   * 列表**未就绪 / 加载失败**时是「不知道」——记 0（不显示通知侧的未读），不拿 mock
   * fixture 计数顶替：那会与底栏的快照口径分叉（底栏对这些状态按「无已知未读」算），
   * 也会把「不知道」画成一个具体的数字。
   */
  const unreadNotifications =
    notifsReady && !notifsFailed ? notifs.filter((item) => item.readAt === null).length : 0

  /**
   * 会话区的渲染形态。判定抽在 `./list-view` 里（纯函数 + 用例）：这里只把三个
   * 事实传进去 —— 把「没读到」显示成「你没有会话」是这一块最容易犯的错。
   */
  const state = chatListState({ ready, failed, itemCount: items.length })

  /** 未读会话（「全部已读」的操作对象） */
  const unreadItems = useMemo(() => items.filter((item) => item.unreadCount > 0), [items])

  /**
   * 未读快照发布：底栏「消息」红点与页内角标同源（见 `features/chat/unread.ts`）。
   *
   * `conversations` 直接发 `loadConversationUnread` 落地的**端点值**（#291：不再对本页
   * 会话列表求和 —— 那只覆盖第一页）。`conversations` 与 `notifications` 在「不知道」
   * （未取到 / 接口失败）时都是 `null`，底栏按「无已知未读」算 —— 与页内同口径。
   * 会话这一项尤其不要发 0：没读到却发 0 会把上一份正确的快照覆盖掉，用户明明还有
   * 未读，那颗点却熄了。未登录不发（登出 / 换账号的清空在身份 effect）。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !identity) return
    publishUnread({
      ownerId: identity,
      conversations: conversationUnread,
      notifications: notifsReady && !notifsFailed ? unreadNotifications : null,
    })
  }, [authStatus, identity, conversationUnread, notifsReady, notifsFailed, unreadNotifications])

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
        const done = new Set(
          unreadItems
            .filter((_, index) => results[index]?.status === 'fulfilled')
            .map((item) => item.id),
        )
        const missed = unreadItems.length - done.size
        /*
         * 反馈放在代次守卫**之前**：这批 POST 已经打到服务端并真的成功了，结论与用户
         * 刚点的那次操作一致。守卫该拦的是「把结果写进已作废的 state」（换账号 / 重载
         * 后迟到的回包），不该把 toast 一起吞掉 —— 否则用户点「全部已读」看不到任何
         * 反馈，只能以为按钮坏了。代价：极端时序下（点击后恰好换账号）会给新账号弹一句
         * 属于上一个账号操作的结果，但这句反馈描述的是**真实发生过**的服务端写结果。
         */
        void Taro.showToast({
          title: missed === 0 ? '已全部标为已读' : `有 ${missed} 个会话标记失败，请重试`,
          icon: 'none',
        })
        if (epoch !== listEpoch.current) return
        if (done.size > 0) {
          setItems((prev) =>
            prev.map((item) => (done.has(item.id) ? { ...item, unreadCount: 0 } : item)),
          )
          // 未读总数以端点为准：本地角标清了，底栏那颗点也要跟着熄，不用等下次进页。
          // 部分失败时端点会如实返回剩余的未读，所以照常重取。
          loadConversationUnread(epoch)
        }
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
    void Taro.navigateTo({ url: `/pkg-social/pages/conversation/index?id=${id}` })
  }

  /** tab 切换：#431 任务二起进「通知」tab 不再整表清零 —— 未读逐条点击才消（见 `openNotif`） */
  const chooseFilter = (key: ChatFilter) => {
    setFilter(key)
  }

  /**
   * 通知条目点击（#431 任务二）：**红点随点击消失** —— 未读条目先乐观置已读（本地
   * `readAt` 立即落位，页内胶囊 / 底栏徽标同步递减），再幂等
   * `POST /notifications/:id/read` 落服务端；回写失败的条目回滚回未读（红点复现），
   * 服务端没记上就不冒充已读。跳转行为不变（按 `target` 分派）。
   */
  const openNotif = (item: MockNotification) => {
    if (item.readAt === null) {
      const epoch = notifEpoch.current
      const readAt = new Date().toISOString()
      setNotifs((prev) =>
        prev.map((n) => (n.id === item.id && n.readAt === null ? { ...n, readAt } : n)),
      )
      void markNotificationsRead([item]).then((markedIds) => {
        if (epoch !== notifEpoch.current || markedIds.has(item.id)) return
        setNotifs((prev) =>
          prev.map((n) => (n.id === item.id && n.readAt === readAt ? { ...n, readAt: null } : n)),
        )
      })
    }
    if (item.target?.kind === 'listing') {
      void Taro.navigateTo({
        url: `/pkg-browse/pages/listing-detail/index?id=${item.target.listingId}`,
      })
      return
    }
    if (item.target?.kind === 'conversation') {
      void Taro.navigateTo({
        url: `/pkg-social/pages/conversation/index?id=${item.target.conversationId}`,
      })
      return
    }
    if (item.target?.kind === 'mylist') {
      void Taro.navigateTo({ url: '/pkg-browse/pages/mylist/index' })
      return
    }
    if (item.target?.kind === 'verify') {
      void Taro.navigateTo({ url: '/pkg-auth/pages/verify/index' })
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
                /**
                 * 各 tab 的徽标数（#431 任务二：胶囊数据一律未读口径）——
                 * 「全部」挂会话未读数和（原为会话总数）；「通知」挂通知未读数（#23 语义不变）
                 */
                const tabBadge = item.key === 'all' ? conversationUnread : unreadNotifications
                return (
                  <View
                    key={item.key}
                    // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child）
                    className={`chat__tab chat__tab--${item.key}${on ? ' is-on' : ''}`}
                    onClick={() => chooseFilter(item.key)}
                  >
                    <Text>{item.label}</Text>
                    {tabBadge > 0 ? (
                      // 2 位以上转胶囊（形状规则见 index.scss 的 num-badge）
                      <Text className={`chat__tab-n num${tabBadge > 9 ? ' is-multi' : ''}`}>
                        {badgeText(tabBadge)}
                      </Text>
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
                  {/* 未读红点（#431 任务二）：`readAt` 权威，点击条目即消失 */}
                  {item.readAt === null ? <View className="notif__dot" /> : null}
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
              /** 交易进度胶囊（#89）：数据源与状态机见 `features/chat/capsule.ts` */
              const capsule = capsuleFor(item, txMap, txSignals)

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
                    {unread > 0 ? (
                      // 两位数与 `99+` 要缩字号才不裁字（见 index.scss 的 .is-multi）
                      <Text className={`chat__bdg num${unread > 9 ? ' is-multi' : ''}`}>
                        {badgeText(unread)}
                      </Text>
                    ) : null}
                  </View>

                  <View className="chat__corp">
                    <View className="chat__corp-top">
                      <Text className="chat__nm-tx">{user.nickname}</Text>
                      {capsule ? (
                        <Text className={`chat__pill ${capsule.cls}`}>{capsule.label}</Text>
                      ) : null}
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

      {/* 1版稿 .totop：滚过一屏半浮现；Tab 页抬到底栏上方 */}
      <BackTop show={showTop} onTop={backToTop} bottom="170rpx" />
    </View>
  )
}
