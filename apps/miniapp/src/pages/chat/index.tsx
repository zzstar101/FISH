import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePageScroll } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { clearUnread, publishUnread } from '@/features/chat/unread'
import { loadNotifications, markNotificationsRead } from '@/features/fetchers'
import {
  type ConversationFilter,
  conversations,
  countByFilter,
  filterConversations,
  formatAmount,
  type MockConversation,
  type MockNotification,
} from '@/mock/api'
import './index.scss'

/** 1版稿筛选纯文字 Tab（顺序：全部 / 通知 / 交易 / 许愿；「通知」页内直显通知列表，会话行只是入口） */
const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'system', label: '通知' },
  { key: 'deal', label: '交易' },
  { key: 'wish', label: '许愿' },
]

/**
 * 系统会话（`kind === 'system'`）的展示名。
 *
 * mock 里这条会话的 `counterpartId` 是当前用户自己（`u-alan`），因为系统通知本来就没有
 * 「对方」；设计稿这一行写的是「鱼小应小助手」，所以这里按会话类型覆盖昵称。
 */
const SYSTEM_NAME = '鱼小应小助手'

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

/**
 * 会话列表的消息预览。
 *
 * 交易类 SYSTEM 消息的 content 是契约里的 JSON 原文
 * （`{"type":"tx.proposal","amountCents":15000}` / `tx.accepted` / `tx.rejected`），
 * 列表里必须翻成中文，不能把 JSON 直接显示出来；解析失败（普通文本的系统消息，
 * 例如「你的学号认证已通过…」）按原文降级。
 */
function previewText(conversation: MockConversation): string {
  const last = conversation.lastMessage
  if (!last) return ''
  // 最后一条是媒体消息（D2）：lastMessage 只承载契约内的文本，媒体走 mediaPreview
  if (conversation.mediaPreview) return conversation.mediaPreview
  if (last.type !== 'SYSTEM') return last.content

  try {
    const event: unknown = JSON.parse(last.content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      if (type === 'tx.proposal') {
        const amount = (event as { amountCents?: unknown }).amountCents
        return typeof amount === 'number'
          ? `买家发起交易确认 · ¥${formatAmount(amount)}，待确认`
          : '买家发起交易确认，待确认'
      }
      if (type === 'tx.accepted') return '交易已确认 · 约定面交中'
      if (type === 'tx.rejected') return '卖家已拒绝本次议价'
      // 1版稿会话页的契约外演示事件（mock/chat.ts）：不映射的话 JSON 会漏进预览
      if (type === 'tx.completed') return '交易已完成'
    }
  } catch {
    // 不是 JSON：按普通文本渲染
  }
  return last.content
}

/**
 * 1版稿名字右侧的状态胶囊配色：待面交=橙，已完成/已取消=灰，其余品牌色。
 * 系统会话在列表里不显示胶囊（1版稿「鱼小应小助手」行只有名字）。
 */
function statusVariant(item: MockConversation): 'warn' | 'done' | null {
  if (item.tag === '待面交') return 'warn'
  if (item.tagDone) return 'done'
  return null
}

export default function Chat() {
  // 消息列表需要登录（GET /conversations）；Tab 页只能用 navigateTo 跳登录页
  const authStatus = useAuthGuard({ tab: true })
  /** 当前账号身份：Tab 页实例跨登录态存活，跨账号重置本地已读状态要用它（见下） */
  const { user: authedUser } = useAuth()
  const [items, setItems] = useState<MockConversation[]>([])
  const [filter, setFilter] = useState<ConversationFilter>('all')
  /** 本地已读：「全部已读」后把这些会话的未读角标清零（不写回 mock） */
  const [readIds, setReadIds] = useState<string[]>([])
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

  /** 加载代次：并发加载（快速换账号 / 连点重试）时只有最后一次的响应落地 */
  const loadEpoch = useRef(0)

  /**
   * 身份切换时的**渲染期重置**（adjust-state-during-render，React 官方推荐的
   * 「存上一帧信息」写法）：Tab 页实例跨登录态存活，`filter` / `notifs` /
   * `readIds` / `notifsViewed` 都是上一个账号的视角，必须在**同一个 commit 内**
   * 换成空值。写成 effect 里 setState 不行 —— 那要到下一帧才生效，兄弟 effect
   * （发布快照 / 已读回写）在本帧仍读到旧值：轻则把上个账号的已读视角发进全局
   * 快照（新账号的红点被误熄），重则拿新账号的 cookie 去 POST 上个账号的通知 id。
   */
  const identity = authedUser?.id ?? null
  const [prevIdentity, setPrevIdentity] = useState<string | null>(identity)
  if (prevIdentity !== identity) {
    setPrevIdentity(identity)
    // 在途响应（列表 / 已读回写）随身份一起作废：自增放在这里（渲染期，同步），
    // 不能放进 effect —— 那之间夹着微任务窗口，上一个账号的响应会写进刚清空的 state
    loadEpoch.current += 1
    setFilter('all')
    setNotifs([])
    setNotifsReady(false)
    setNotifsFailed(false)
    setReadIds([])
    setNotifsViewed(false)
  }

  /** 通知列表加载：与原独立通知页同一份数据层（真接口失败回退 mock），重试也走这里 */
  const loadNotifs = useCallback(() => {
    const epoch = ++loadEpoch.current
    void loadNotifications()
      .then(({ items: list, failed: nextFailed }) => {
        // 并发加载（快速换账号 / 连点重试）时旧响应后到，不能覆盖新账号的列表
        if (epoch !== loadEpoch.current) return
        setNotifs(list)
        setNotifsFailed(nextFailed)
        setNotifsReady(true)
      })
      .catch((error) => {
        // 取数层自己吞了接口失败，这里兜的是「回退 mock 的动态 import 也失败」：
        // 少了这个 catch，notifsReady 会永远为 false —— 通知 tab 既没有错误态、
        // 也没有重试钮，看起来像「一直没加载完」
        console.warn('[miniapp] 通知列表加载异常', error)
        if (epoch !== loadEpoch.current) return
        setNotifsFailed(true)
        setNotifsReady(true)
      })
  }, [])

  /**
   * 登录态变化的取数：登录 / 换账号后重拉通知列表，并**先丢弃共享未读快照**。
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
    loadNotifs()
  }, [authStatus, authedUser, loadNotifs])

  useLoad(() => {
    // 会话数据是本地 mock（同步），保留 state 是为了将来换成真接口时页面结构不用改；
    // 通知列表由上面的登录态 / 身份 effect 拉取 —— 未登录时不打必然 401 的请求
    setItems(conversations())
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

  /** 已读处理后的会话：计数、筛选、角标都只看这一份，避免三处各算一遍 */
  const shown = useMemo(
    () => items.map((item) => (readIds.includes(item.id) ? { ...item, unreadCount: 0 } : item)),
    [items, readIds],
  )
  const counts = useMemo(() => countByFilter(shown), [shown])
  const visible = useMemo(() => filterConversations(shown, filter), [shown, filter])

  /**
   * 「交易」「许愿」tab 的未读数：该分类下所有会话的**未读条数之和**（行角标同口径）。
   * 消除只有一条路：点进对应会话（`openConversation` 把它写进本地已读，
   * `shown` 里该会话的 unreadCount 归零，这里的和随之下降）。
   */
  const dealUnread = useMemo(
    () => filterConversations(shown, 'deal').reduce((sum, item) => sum + item.unreadCount, 0),
    [shown],
  )
  const wishUnread = useMemo(
    () => filterConversations(shown, 'wish').reduce((sum, item) => sum + item.unreadCount, 0),
    [shown],
  )

  /**
   * 会话未读条数和：底栏「消息」红点的会话部分，与「交易 / 许愿」tab 数字同口径。
   * **不含系统会话**：它的未读由「通知」承载（行角标见 `effectiveUnread`），
   * 自己的 `unreadCount` 没有任何展示件，也不该在底栏亮一个用户清不掉的幽灵红点。
   */
  const conversationUnread = useMemo(
    () => shown.reduce((sum, item) => sum + (item.kind === 'system' ? 0 : item.unreadCount), 0),
    [shown],
  )

  /**
   * 未读快照发布：底栏「消息」红点与页内角标同源（见 `features/chat/unread.ts`）。
   * 此前底栏自己从 mock fixture 现算、只看登录态，页内清掉的未读它一概不知道 ——
   * 现在切进「通知」tab / 点进会话，各 Tab 页的底栏实例随之重算红点。
   *
   * 两个字段的可信度不同，分开对待：`conversations` 来自本地会话列表，与通知接口
   * 成败无关，**恒发**；`notifications` 在列表未就绪 / 加载失败时发 `null`（「不知道」），
   * 底栏对该字段按「无已知未读」算 —— 与页内角标同口径（那时页内也是 0）。
   * 未登录不发（登出 / 换账号的清空在身份 effect，不能把 mock 派生值再发回去）。
   */
  useEffect(() => {
    if (authStatus !== 'authed' || !identity) return
    publishUnread({
      ownerId: identity,
      conversations: conversationUnread,
      notifications: notifsReady && !notifsFailed ? unreadNotifications : null,
    })
  }, [authStatus, identity, notifsReady, notifsFailed, conversationUnread, unreadNotifications])

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
    const epoch = loadEpoch.current
    void markNotificationsRead(pending).then((markedIds) => {
      if (epoch !== loadEpoch.current || markedIds.size === 0) return
      setNotifs((prev) =>
        prev.map((item) =>
          item.readAt === null && markedIds.has(item.id)
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      )
    })
  }, [authStatus, notifsViewed, notifs, notifsReady])

  const markAllRead = () => {
    if (counts.unread === 0) {
      void Taro.showToast({ title: '没有未读会话', icon: 'none' })
      return
    }
    setReadIds(items.map((item) => item.id))
    void Taro.showToast({ title: '已全部标为已读', icon: 'none' })
  }

  /** 进会话即视为已读：行角标与「交易 / 许愿」tab 数字随之消除（本地态，见 `readIds`） */
  const openConversation = (id: string) => {
    setReadIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    void Taro.navigateTo({ url: `/pages/conversation/index?id=${id}` })
  }

  /** tab 切换：进「通知」tab 即视为已读（角标清零；真实 mark-read 由上方 effect 声明式补标） */
  const chooseFilter = (key: ConversationFilter) => {
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
   * 守卫只负责跳转，跳转可能失败（页面栈、Tab 页限制），而且数据本身来自 mock ——
   * 不拦渲染的话，未登录用户会看到一串演示会话（`docs` 里的「未登录看到演示数据」）。
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
                 * 各 tab 的数字：「全部」挂会话总数；「交易 / 许愿」挂该分类的未读条数和
                 * （点进对应会话才消除，见 `dealUnread` / `wishUnread`）；「通知」挂通知
                 * 未读数（#23，切进 tab 即清零）。
                 */
                const tabBadge = {
                  all: counts.all,
                  unread: 0,
                  deal: dealUnread,
                  wish: wishUnread,
                  system: unreadNotifications,
                }[item.key]
                return (
                  <View
                    key={item.key}
                    // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child）
                    className={`chat__tab chat__tab--${item.key}${on ? ' is-on' : ''}`}
                    onClick={() => chooseFilter(item.key)}
                  >
                    <Text>{item.label}</Text>
                    {tabBadge > 0 ? <Text className="chat__tab-n num">{tabBadge}</Text> : null}
                  </View>
                )
              })}
            </View>

            <View className="chat__readall" onClick={markAllRead}>
              <Image
                className="chat__readall-ic"
                src={counts.unread === 0 ? ICONS.readallMuted : ICONS.readallAccent}
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
        直接渲染在这里（页面已删），「全部」等其余 tab 仍是会话行。
        系统会话行（「鱼小应小助手」）是「通知」tab 的**页内入口**：点击切 tab，
        不再 navigateTo（见 `chooseFilter`）；它的角标挂通知未读数（#23），
        普通会话行挂自己的未读数。
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
        ) : (
          <>
            {visible.map((item) => {
              const isSystem = item.kind === 'system'
              /** 直接消费契约 `ConversationDto.counterpart`，不再拿 id 自己查表 */
              const user = item.counterpart
              const name = isSystem ? SYSTEM_NAME : user.nickname
              const tick = !isSystem && user.authStatus === 'VERIFIED'
              const unread = item.unreadCount
              const variant = statusVariant(item)
              /** 系统行挂通知未读数（#23），普通行挂自己的未读数；角标与未读高亮同源 */
              const effectiveUnread = isSystem ? unreadNotifications : unread

              return (
                <View
                  key={item.id}
                  className={`chat__conv${effectiveUnread > 0 ? ' is-unread' : ''}`}
                  onClick={() => (isSystem ? chooseFilter('system') : openConversation(item.id))}
                >
                  {/* 头像 + 认证章 + 未读角标：要浮到头像外，所以裁剪只落在 .chat__ava 上 */}
                  <View className="chat__ava-wrap">
                    <View className={`chat__ava${isSystem ? ' chat__ava--sys' : ''}`}>
                      {isSystem ? (
                        <Image className="chat__ava-ic" src={ICONS.shieldWhite} mode="aspectFit" />
                      ) : (
                        // 契约允许 avatarUrl 为 null（users.avatar_url 可空）；空串即不渲染图
                        <Image
                          className="chat__ava-img"
                          src={user.avatarUrl ?? ''}
                          mode="aspectFill"
                        />
                      )}
                    </View>
                    {tick ? (
                      <View className="chat__cert">
                        <Image className="chat__cert-ic" src={ICONS.checkWhite} mode="aspectFit" />
                      </View>
                    ) : null}
                    {effectiveUnread > 0 ? (
                      <Text className="chat__bdg num">{effectiveUnread}</Text>
                    ) : null}
                  </View>

                  <View className="chat__corp">
                    <View className="chat__corp-top">
                      <Text className="chat__nm-tx">{name}</Text>
                      {item.tag && !isSystem ? (
                        <Text className={`chat__st${variant ? ` chat__st--${variant}` : ''}`}>
                          {item.tag}
                        </Text>
                      ) : null}
                    </View>
                    <Text className="chat__msg">{previewText(item)}</Text>
                    {/* 1版稿时间在第三行（消息下方），不再是行右上角 */}
                    <Text className="chat__tm num">{item.timeLabel}</Text>
                  </View>

                  {/* 右侧商品缩略图（1版稿 .thumb）：契约 `listing.coverUrl`，系统行走品牌渐变底 */}
                  <View className={`chat__thumb${isSystem ? ' chat__thumb--brand' : ''}`}>
                    {isSystem ? (
                      <Image className="chat__thumb-ic" src={ICONS.shieldWhite} mode="aspectFit" />
                    ) : item.listing.coverUrl ? (
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

            {visible.length === 0 ? (
              <View className="chat__empty">
                <Text className="chat__empty-title">这里还没有会话</Text>
                <Text className="chat__empty-text">换个筛选看看其他消息</Text>
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
