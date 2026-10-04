import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import TopBar from '@/components/top-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchMyComments } from '@/features/comments/api'
import { fetchMyFavorites } from '@/features/favorites/api'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { clearMyViewHistory, fetchMyViewHistory } from '@/features/view-history/api'
import { formatAmount } from '@/lib/money'
import { isApiError } from '@/lib/request'
import {
  applyCleared,
  blockUrlOf,
  CLEAR_LABEL,
  type ClearedState,
  canClear,
  clearBlockedOf,
  clearDoneOf,
  clearedOf,
  DEMO_OPEN_TIP,
  type DemoRecords,
  emptyCopyOf,
  emptyKindOf,
  favoriteCell,
  fetchDemoRecords,
  groupByDay,
  type HistoryDay,
  type HistoryTab,
  loadingTextOf,
  MESSAGE_KIND_LABEL,
  type MessageRecord,
  messageRow,
  NOTHING_CLEARED,
  noteOf,
  type RecordCell,
  shortLabelOf,
  TABS,
  tailTextOf,
  viewHistoryCell,
  withCleared,
} from './records'
import './index.scss'

/**
 * 历史浏览（设计稿 `D:\新建文件夹\小程序1版history.html`，方案
 * `D:\FISH\四页面并行-收藏历史评论关注.md` §3.2）。
 *
 * 结构（**顶栏形态照消息页**，Owner 2026-09-23 定版）：一级标题「历史浏览」
 * （「历史」走 `--fg`、「浏览」走品牌蓝，与消息页的「消 + 息」同款两段式）+
 * 返回钮 + 右端「清空」，全部在 `components/top-bar` 的玻璃主行里；
 * 三档 tab 作为**副行**并入同一块玻璃（`below`）→ 内容区 → 骨架屏 / 空态 /
 * 底部说明 / 到底提示 → 回到顶部钮。
 * 下拉刷新用微信原生（`index.config.ts` 的 `enablePullDownRefresh` + 本页的
 * `usePullDownRefresh`，先例 `pages/orders-buy`），**不手写假 refresher**。
 *
 * ## 三档的数据源（#415 / #190 / #195 落地后的现状，详见 `./records` 的表）
 *
 * - **真实构建**三档各自接真：浏览档 `GET /me/view-history`（30 天窗口）、收藏档
 *   `GET /me/favorites`、留言档 `GET /me/comments?kind=all`。每档**翻页取全**
 *   （与收藏页同一手法：游标翻到 `nextCursor === null`，翻页上限只兜服务端 bug），
 *   因为底部的「已显示全部 N 件/条」是派生文案，只有取全才说得出口；取不全（翻到上限
 *   或游标没前进）就藏起这句、也不显示任何计数。
 * - **演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，两个开关的口径与
 *   「我的」页回退一致）读 fixture，行为与 #196 时代一致。
 * - 请求失败是**错误态 + 重试**，不用空态冒充（与收藏页同一口径）。
 *
 * ## 「清空」的口径
 *
 * - 演示构建：三档都清本页那份演示数组（离开页面回到清空前 —— 已知且故意接受）；
 * - 真实构建：**只有浏览档**有批量写端点（`DELETE /me/view-history`，幂等），
 *   二次确认后真发、成功后重拉；收藏 / 留言档没有批量端点，顶栏按钮在该档**隐藏**
 *   （不是摆一个点了没反应的死按钮）。
 *
 * ## 账号作用域
 *
 * 真实取数用请求代次 + 身份比对丢弃迟到响应（与 `features/transaction/useOrderList`
 * 同一手法）；「清空过哪几档」（演示）在换账号时**渲染期重置**（与 `pages/mylist` 同款）。
 */

/** 翻页取全的上限。只兜「服务端一直回同一个 cursor」这类 bug，正常用户的量远小于它。 */
const MAX_PAGES = 10

/** 空态图标（稿 `EMPTY` 表的三支）：只从 `@/assets/lib-icons` 的 `ICONS` 取。 */
const EMPTY_ICON: Record<HistoryTab, string> = {
  history: ICONS.clockMuted,
  favs: ICONS.heartMuted,
  msgs: ICONS.commentMuted,
}

/** 真实构建三档各自的数据（`null` = 这一次身份还没读过这一档）。 */
type RealRecords = {
  history: HistoryDay[] | null
  favs: RecordCell[] | null
  msgs: MessageRecord[] | null
}

const NO_REAL_RECORDS: RealRecords = { history: null, favs: null, msgs: null }

/**
 * 游标翻页取全（先例 `pages/favorites` 的 `loadFavorites`）。
 * `truncated` = 翻到上限 / 服务端游标没前进 —— 调用方不能把它的长度当总数。
 */
async function fetchAllPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchPage(cursor)
    items.push(...response.items)
    if (response.nextCursor === null) return { items, truncated: false }
    // 游标没前进 = 服务端在重复给同一页，收下会让列表翻倍、`key` 重复
    if (response.nextCursor === cursor) return { items, truncated: true }
    cursor = response.nextCursor
  }
  return { items, truncated: true }
}

/** 拉一档的全部记录（适配成页面行）。 */
async function fetchRealRecords(tab: HistoryTab): Promise<{
  truncated: boolean
  days?: HistoryDay[]
  favs?: RecordCell[]
  msgs?: MessageRecord[]
}> {
  const nowMs = Date.now()
  if (tab === 'history') {
    const { items, truncated } = await fetchAllPages((cursor) => fetchMyViewHistory({ cursor }))
    return {
      truncated,
      days: groupByDay(
        items.map((row) => ({ ...viewHistoryCell(row), viewedAt: row.viewedAt })),
        nowMs,
      ),
    }
  }
  if (tab === 'favs') {
    const { items, truncated } = await fetchAllPages((cursor) => fetchMyFavorites(cursor))
    return { truncated, favs: items.map(favoriteCell) }
  }
  const { items, truncated } = await fetchAllPages((cursor) =>
    fetchMyComments({ kind: 'all', cursor }),
  )
  return { truncated, msgs: items.map((row) => messageRow(row, nowMs)) }
}

export default function History() {
  const authStatus = useAuthGuard()
  const userId = useAuth().user?.id ?? null

  /**
   * 演示构建才摆演示数据：开关口径是 `MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`
   * （**不能**只认前一个 —— `dev:weapp` 的日常开发也满足它，会顶掉真实数据）。
   */
  const demo = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

  const [tab, setTab] = useState<HistoryTab>('history')
  const [data, setData] = useState<DemoRecords | null>(null)
  const [real, setReal] = useState<RealRecords>(NO_REAL_RECORDS)
  /** 每档的「列表不完整」（真实构建翻页到上限 / 游标没前进） */
  const [truncatedTab, setTruncatedTab] = useState<Record<HistoryTab, boolean>>({
    history: false,
    favs: false,
    msgs: false,
  })
  /** 初值：演示构建首帧要等 fixture 的 300ms「往返」；真实构建首帧在等请求 */
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showTop, setShowTop] = useState(false)
  /** 重拉（下拉刷新 / 清空成功 / 错误重试）：自增即驱动下面的 effect */
  const [reloadToken, setReloadToken] = useState(0)
  /** 清空写请求在飞（真实构建；挡连点） */
  const clearingRef = useRef(false)

  /**
   * 「清空过哪几档」。三个布尔量，**只活在本次页面实例内**（演示构建专用）。
   * ⚠️ 离开页面再进来就回到「没清过」—— 已知且故意接受的行为，不是漏做：
   * 真实构建的清空是服务端写，由服务端返回的列表决定显示；把演示期的「清过了」
   * 持久化下去会让用户再也看不到这一页。
   */
  const [clearedState, setClearedState] = useState<ClearedState>({
    ...NOTHING_CLEARED,
    ownerId: null,
  })
  /**
   * 换账号 / 退出时的**渲染期重置**（与 `pages/mylist` 同款写法）：
   * 「清空过」是上一个账号的视角，必须在**同一帧内**清掉。
   */
  const [prevClearedUser, setPrevClearedUser] = useState<string | null>(userId)
  if (prevClearedUser !== userId) {
    setPrevClearedUser(userId)
    setClearedState({ ...NOTHING_CLEARED, ownerId: null })
    setReal(NO_REAL_RECORDS)
    setLoading(true)
    setError(null)
  }

  /**
   * 请求代次：换账号 / 切档 / 下拉刷新都会自增，迟到的响应按过期整批丢弃
   * （真实与演示两条路共用同一把尺子）。
   */
  const reqId = useRef(0)
  /** 上一次 effect 跑的是哪个账号哪个档：判断「这次是不是同数据的刷新」 */
  const lastLoadRef = useRef<{ ownerId: string | null; tab: HistoryTab }>({
    ownerId: null,
    tab: 'history',
  })

  useEffect(() => {
    const previous = lastLoadRef.current
    const sameOwner = previous.ownerId !== null && userId !== null && previous.ownerId === userId
    const sameTab = previous.tab === tab
    /** 下拉刷新 / 清空后的重拉：保留已显示的数据，不换骨架屏（保住阅读位置） */
    const isRefresh = reloadToken > 0 && sameOwner && sameTab
    lastLoadRef.current = { ownerId: userId, tab }

    const epoch = ++reqId.current
    if (!isRefresh) {
      setLoading(true)
      setError(null)
      if (!demo && !sameTab) {
        // 切档：先清掉上一档已渲染的数据，避免骨架屏底下还压着上一档的列表
        setReal((prev) => ({ ...prev, [tab]: null }))
      }
    }

    if (authStatus !== 'authed' || userId === null) {
      // 未登录 / 登录态未就绪时守卫在跳转，这里不亮骨架屏、不发票
      setLoading(false)
      void Taro.stopPullDownRefresh()
      return
    }

    const forUserId = userId
    void (demo ? fetchDemoRecords(forUserId) : fetchRealRecords(tab)).then(
      (next) => {
        if (reqId.current !== epoch || forUserId !== userId) return
        if (demo) {
          setData(next as DemoRecords)
        } else {
          const result = next as Awaited<ReturnType<typeof fetchRealRecords>>
          setReal((prev) => ({
            history: result.days ?? prev.history,
            favs: result.favs ?? prev.favs,
            msgs: result.msgs ?? prev.msgs,
          }))
          setTruncatedTab((prev) => ({ ...prev, [tab]: result.truncated }))
        }
        setLoading(false)
        void Taro.stopPullDownRefresh()
      },
      (caught: unknown) => {
        if (reqId.current !== epoch || forUserId !== userId) return
        // 失败不动已显示的数据：保留上一次成功的结果，错误态由渲染层接手
        setError(isApiError(caught) ? caught.message : '网络不太好，没读出来')
        setLoading(false)
        void Taro.stopPullDownRefresh()
      },
    )
  }, [demo, authStatus, userId, reloadToken, tab])

  /** 当前账号的「已清空」标记（演示构建专用；账号对不上时是「都没清过」） */
  const cleared = useMemo(() => clearedOf(clearedState, userId), [clearedState, userId])
  const isCleared = cleared[tab]

  /** 上屏的数据：演示 = 演示数据减去清空过的档；真实 = 服务端那份。 */
  const shown = useMemo(() => (data === null ? null : applyCleared(data, cleared)), [data, cleared])
  const days = demo ? (shown?.days ?? []) : (real.history ?? [])
  const favs = demo ? (shown?.favs ?? []) : (real.favs ?? [])
  const msgs = demo ? (shown?.msgs ?? []) : (real.msgs ?? [])

  /** 当前档位渲染出来的条目数：三档各自的列表长度现算（`history` 是**件数**不是天数） */
  const shownCount =
    tab === 'history'
      ? days.reduce((n, d) => n + d.items.length, 0)
      : tab === 'favs'
        ? favs.length
        : msgs.length

  /** 当前的真实数据是否已就位（决定骨架屏是否顶替内容） */
  const realReady =
    tab === 'history'
      ? real.history !== null
      : tab === 'favs'
        ? real.favs !== null
        : real.msgs !== null
  /** 骨架屏只在「还没有数据」时顶替内容（下拉刷新保留了列表，不换骨架屏） */
  const pending = loading && (demo ? data === null : !realReady)

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  const toast = (text: string) => {
    void Taro.showToast({ title: text, icon: 'none' })
  }

  /** 下拉刷新：两种构建都重拉当前档（原生指示器在结果落地时收起）。 */
  usePullDownRefresh(() => {
    setReloadToken((token) => token + 1)
  })

  /**
   * 顶栏右端「清空」。
   *
   * - **演示构建**：清掉当前档的演示记录 —— 列表当场变空、并切到「已清空」空态。
   * - **真实构建**：只有浏览档能走到这（其它档按钮隐藏，见渲染处）——
   *   二次确认后真发 `DELETE /me/view-history`（幂等），成功后重拉由服务端给空列表。
   */
  const clearTab = () => {
    if (!canClear(demo, tab) || userId === null) {
      toast(clearBlockedOf(tab))
      return
    }
    if (demo) {
      setClearedState((prev) => withCleared(prev, userId, tab))
      toast(clearDoneOf(tab))
      return
    }
    if (clearingRef.current) return
    void Taro.showModal({
      title: '清空浏览记录？',
      content: '将清空最近 30 天的全部浏览足迹，不可恢复。',
      confirmColor: '#e5484d',
    })
      .then(async (result) => {
        if (!result.confirm) return
        clearingRef.current = true
        try {
          await clearMyViewHistory()
          toast(clearDoneOf(tab))
          setReloadToken((token) => token + 1)
        } catch (caught) {
          toast(isApiError(caught) ? caught.message : '清空没成功，请重试')
        } finally {
          clearingRef.current = false
        }
      })
      .catch(() => {})
  }

  /** 切档位：回到顶部（否则从长列表切到短列表会停在半空） */
  const pickTab = (key: HistoryTab) => {
    if (key === tab) return
    setTab(key)
    void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })
  }

  /**
   * 格子 / 留言行的跳转：真实行带真实 id（格子 → 商品详情；留言行按类型跳商品 /
   * 面交订单页），演示 id 在库里不存在，跳过去必然 404 —— 给明确的演示说明，
   * 不假装跳转成功（方案 §2.3）。
   */
  const openCell = (item: RecordCell) => {
    if (demo) {
      toast(DEMO_OPEN_TIP)
      return
    }
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.id}` })
  }

  const openMsg = (item: MessageRecord) => {
    if (demo || item.target === undefined) {
      toast(DEMO_OPEN_TIP)
      return
    }
    if (item.target.kind === 'transaction') {
      void Taro.navigateTo({ url: `/pages/transaction-meetup/index?id=${item.target.id}` })
      return
    }
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.target.id}` })
  }

  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /** 三列格（全部浏览 / 我收藏的共用）：封面（无图退色块）+ 品类小字 + 失效遮罩 + 格下价格 */
  const renderCell = (item: RecordCell) => (
    <View key={item.id} className="hist__cell">
      <View className={`hist__thumb${item.gone ? ' is-gone' : ''}`} onClick={() => openCell(item)}>
        <Image
          className="hist__thumb-img"
          src={item.coverUrl ?? blockUrlOf(item.category)}
          mode="aspectFill"
        />
        <Text className="hist__ttag">{shortLabelOf(item.category)}</Text>
        {item.gone ? <Text className="hist__tgone">{item.gone}</Text> : null}
      </View>
      <Text className="hist__price num">
        <Text className="hist__price-cur">¥</Text>
        {formatAmount(item.priceCents)}
      </Text>
    </View>
  )

  /** 真实构建当前档是否取全（决定「已显示全部」这句能不能说） */
  const currentTruncated = truncatedTab[tab]

  return (
    <View className="hist">
      {/* 顶部冰蓝渐变圆角背景（稿 `.pagehead` 的 --grad-page + 下缘 32pt 圆角） */}
      <View className="hist__bg" />

      {/*
        顶栏（Owner 2026-09-23 定版，照消息页）：glass 变体 —— 返回钮 + 两段式标题 +
        右端「清空」，三档 tab 作为**副行**并入同一块玻璃（`below`），内容从底下滚过。
        「清空」放中槽靠右（`.topbar__actions` 没有 `margin-left: auto`，见 #196 时的实测）。
        真实构建下只有浏览档显示「清空」—— 收藏 / 留言档没有批量写端点，隐藏而不是摆死按钮。
      */}
      <TopBar
        variant="glass"
        spacer
        back
        onBack={() => {
          const pages = Taro.getCurrentPages()
          if (pages.length > 1) void Taro.navigateBack()
          else void Taro.switchTab({ url: '/pages/home/index' })
        }}
        title="历史"
        titleEm="浏览"
        center={
          demo || tab === 'history' ? (
            <View className="hist__navacts">
              <View className="hist__clear" onClick={clearTab}>
                <Text>{CLEAR_LABEL}</Text>
              </View>
            </View>
          ) : undefined
        }
        below={
          <View className="hist__tabs">
            {TABS.map((item) => (
              <View
                key={item.key}
                className={`hist__tab hist__tab--${item.key}${item.key === tab ? ' is-on' : ''}`}
                onClick={() => pickTab(item.key)}
              >
                <Text>{item.label}</Text>
              </View>
            ))}
          </View>
        }
      />
      {/* 副行占位：组件的 `spacer` 只含主行，tab 行这一截要页面自己补 */}
      <View className="hist__header-gap" />

      <View className="hist__body">
        {pending ? (
          <>
            {/* 骨架屏按**当前档位**的版式画：浏览 / 收藏是三列格，留言是整宽行 */}
            {tab === 'history' ? <View className="hist__skel-date" /> : null}
            {tab === 'msgs' ? (
              <View>
                {[0, 1, 2].map((i) => (
                  <View key={`sk-${i}`} className="hist__skel-row">
                    <View className="hist__skel-rthumb" />
                    <View className="hist__skel-lines">
                      <View className="hist__skel-line" style={{ width: '52%' }} />
                      <View className="hist__skel-line" style={{ width: '86%' }} />
                      <View className="hist__skel-line" style={{ width: '28%' }} />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <View className="hist__grid">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <View key={`sk-${i}`} className="hist__skel-cell">
                    <View className="hist__skel-sq" />
                    <View className="hist__skel-bar" style={{ width: '60%' }} />
                  </View>
                ))}
              </View>
            )}

            <View className="hist__skel-hint">
              <View className="hist__spin" />
              <Text>{loadingTextOf(tab)}</Text>
            </View>
          </>
        ) : error !== null ? (
          /*
            失败态**不能**用空态冒充：空是「你真的没有记录」，失败是「这次没读到」——
            混在一起用户会以为自己的记录丢了（与收藏页同一口径）。
          */
          <EmptyState
            title="没读出来"
            text={error}
            icon={EMPTY_ICON[tab]}
            actionText="重试"
            onAction={() => setReloadToken((token) => token + 1)}
          />
        ) : shownCount === 0 ? (
          /*
            空态两种来由分开说（`emptyKindOf`）：
            - 没清过 → 恰好没有记录（真实与演示同义）；
            - 演示构建刚清过 → 「已清空」。若复用前者，
              用户会看到「我明明清空的，怎么说是没有记录」。
          */
          <EmptyState
            title={emptyCopyOf(tab, emptyKindOf(isCleared)).title}
            text={emptyCopyOf(tab, emptyKindOf(isCleared)).text}
            actionText={emptyCopyOf(tab, emptyKindOf(isCleared)).action}
            onAction={() => void Taro.switchTab({ url: '/pages/home/index' })}
            icon={EMPTY_ICON[tab]}
          />
        ) : (
          <View>
            {tab === 'history'
              ? /* 全部浏览：按天分组（日期来自**足迹记录**，稿决策⑦）+ 三列格 */
                days.map((day) => (
                  <View key={day.date} className="hist__group">
                    <View className="hist__ghead">
                      <Text className="hist__gdate">{day.date}</Text>
                      <Text className="hist__gcount">{`${day.items.length} 件`}</Text>
                    </View>
                    <View className="hist__grid">{day.items.map(renderCell)}</View>
                  </View>
                ))
              : null}

            {tab === 'favs' ? (
              /* 我收藏的：三列格（失效角标与收藏页同源，稿决策⑥） */
              <View className="hist__grid">{favs.map(renderCell)}</View>
            ) : null}

            {tab === 'msgs' ? (
              /* 我留言的：整宽行 —— 缩略图 + 标题 + 类型胶囊 + 我那句话（2 行）+ 时间。
                 刻意**不显示价格**（稿决策④：这一档找的是「我当时说了什么」）。 */
              <View className="hist__rows">
                {msgs.map((item) => (
                  <View key={item.id} className="hist__row" onClick={() => openMsg(item)}>
                    <View className="hist__rthumb">
                      <Image
                        className="hist__rthumb-img"
                        src={item.coverUrl ?? blockUrlOf(item.category ?? 'OTHER')}
                        mode="aspectFill"
                      />
                      {item.category !== null ? (
                        <Text className="hist__rthumb-tag">{shortLabelOf(item.category)}</Text>
                      ) : null}
                    </View>
                    <View className="hist__rmain">
                      <View className="hist__rtop">
                        <Text className="hist__rtitle">{item.title}</Text>
                        <Text className={`hist__rkind${item.kind === 'review' ? ' is-trade' : ''}`}>
                          {MESSAGE_KIND_LABEL[item.kind]}
                        </Text>
                      </View>
                      {item.text !== '' ? <Text className="hist__rtext">{item.text}</Text> : null}
                      <Text className="hist__rtime">{item.timeLabel}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {/* 底部说明：只有浏览档有（「最近 30 天」措辞的留档说明见 records.noteOf） */}
            {noteOf(tab) ? <Text className="hist__note">{noteOf(tab)}</Text> : null}

            {/* 到底提示：列表非空且**确实取全**才渲染（truncated 时不知道全貌，不说话） */}
            {!currentTruncated ? (
              <View className="hist__tail">
                <View className="hist__tail-line" />
                <Text className="hist__tail-tx num">{tailTextOf(tab, shownCount)}</Text>
                <View className="hist__tail-line" />
              </View>
            ) : null}
          </View>
        )}
      </View>

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
