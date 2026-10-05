import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchMyComments } from '@/features/comments/api'
import { fetchMyFavorites } from '@/features/favorites/api'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { clearMyViewHistory, fetchMyViewHistory } from '@/features/view-history/api'
import { cancellable } from '@/lib/cancellable'
import { formatAmount } from '@/lib/money'
import {
  applyCleared,
  blockUrlOf,
  CLEAR_LABEL,
  type ClearedState,
  canClearTab,
  clearBlockedOf,
  clearDoneOf,
  clearedOf,
  DEMO_OPEN_TIP,
  type DemoRecords,
  type EmptyKind,
  emptyCopyOf,
  emptyKindOf,
  favoriteCell,
  fetchDemoRecords,
  type HistoryDay,
  type HistoryTab,
  historyDaysOf,
  loadingTextOf,
  MESSAGE_KIND_LABEL,
  type MessageRecord,
  mergeHistoryItems,
  messageRow,
  NOTHING_CLEARED,
  noteOf,
  type RecordCell,
  recordNameOf,
  shortLabelOf,
  TABS,
  tailTextOf,
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
 * ## 三档数据源现状（2026-10 核对）
 *
 * | 能力 | 现状 | 证据 |
 * | --- | --- | --- |
 * | 浏览足迹 | ✅ 已接（#415 M1） | `GET /me/view-history` → `@/features/view-history/api`；按日分组 + 游标分页 + 真实清空 |
 * | 收藏 | ✅ 已接（#394 端点 + 本页接线） | `GET /me/favorites` → `@/features/favorites/api` 的 `fetchMyFavorites`；翻页取全 |
 * | 「我发过的留言」聚合 | ✅ 已接（#195 端点 + 本页接线） | `GET /me/comments?kind=all` → `@/features/comments/api` 的 `fetchMyComments`；留言 ∪ 交易评价合并时间线，翻页取全 |
 * | 交易评价 / 评分 | ✅ 已接 | `@fish/contracts/transaction-reviews`；`/me/comments?kind=all` 的评价行是 `TransactionReviewItem`（评价 + 查看者视角交易 DTO） |
 *
 * 因此：
 * - **真实构建**（`MOCK_FALLBACK_ENABLED === false`）三档都读真接口：浏览档走增量
 *   「加载更多」，收藏 / 留言两档走**翻页取全**（取全才敢说「已显示全部」）；
 * - **演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，两个开关的口径与
 *   「我的」页回退口径一致）三档都摆演示数据；
 * - **不做 N+1 拼装**（不遍历自己的商品逐个拉 `GET /listings/:id/comments` 过滤作者来假装
 *   汇总 —— 那既慢又不完整）。
 *
 * ## 「清空」清掉了什么
 *
 * - **真实构建 · 浏览档**：`DELETE /me/view-history`（幂等）—— 成功后以服务端为准：
 *   本地列表清空并切到「已清空」空态；失败只 toast 服务端文案、**不做任何本地翻转**；
 *   下拉刷新重取第一页仍是空（服务端那份记录已经删了）。
 * - **真实构建 · 收藏 / 留言档**：没有「清空我这一档」的写端点（收藏只有单品取消、
 *   留言只有单条删除），只给一句说明（`clearBlockedOf`），不做本地翻转。
 * - **演示构建**：清掉的就是本页自己那份演示记录 —— 点完列表真的空了、并切到
 *   「已清空」空态，下拉刷新之后仍然为空（`applyCleared` 按渲染期派生，不在取数里改数据）。
 *
 * ⚠️ **一条已知且刻意接受的边界**（Owner 2026-09-23 已确认口径）：**演示构建**下
 * 离开页面再进来会回到清空前 —— 标记只在页面实例内，**不落本机存储**：真实数据由服务端
 * 说了算（真实浏览档已是这样），把演示期的「清过了」永久留在设备上会让用户再也看不到
 * 这一页。演示数据本来就是临时的；本页也**不摆「这是演示数据」的门牌**（说明条按 Owner
 * 要求去掉），静态看上去与真实页面无异。
 *
 * ## 账号作用域
 *
 * 取数（演示三档与真实浏览档）都包在 `@/lib/cancellable` 里（先例 `pages/profile` /
 * `pages/orders-buy`）：换账号 / 退出时 effect 重跑即取消上一轮，迟到结果按 `null` 丢弃。
 * 「清空过哪几档」（演示）与真实浏览档的列表在换账号时**渲染期重置**
 * （与 `pages/mylist` 同款）。
 */

/**
 * 空态图标（稿 `EMPTY` 表的三支）：只从 `@/assets/lib-icons` 的 `ICONS` 取。
 * 稿里的内联 `<svg>`（ic-clock / ic-heart / ic-comment）一律换成库里已有的对应图标。
 */
const EMPTY_ICON: Record<HistoryTab, string> = {
  history: ICONS.clockMuted,
  favs: ICONS.heartMuted,
  msgs: ICONS.commentMuted,
}

/**
 * 真实构建 · 浏览档的取数结果。
 *
 * `items` 与 `days` 都存：`days` 是上屏的分组视图；「加载更多」追加一页时必须先把
 * **累计的原始 items** 重新分组（同一天可能横跨两页，直接拼 `days` 会让同一天出现两组、
 * 还会撞 React 的 `key={day.date}`）。`total` 是服务端 30 天窗口内的**全量**计数，
 * 与「我的」页数字栏同源。
 */
type RealHistory = {
  ownerId: string
  items: ViewHistoryItem[]
  days: HistoryDay[]
  nextCursor: string | null
  total: number
}

/**
 * 真实构建 · 收藏档 / 留言档的取数结果（**翻页取全**，与浏览档的增量「加载更多」不同）。
 *
 * 这两档没有「加载更多」按钮：底部的「已显示全部 N 件 / N 条」是**派生文案**，只有把游标
 * 翻到底才说得出口（先例 `pkg-browse/pages/favorites` 的 `loadFavorites`）。翻不到底
 * （`truncated`：撞上限或服务端游标没前进）就只报条数、不说「全部」。
 */
type RealList<T> = {
  ownerId: string
  rows: T[]
  truncated: boolean
}

/** 翻页取全的上限。只兜「服务端一直回同一个 cursor」这类 bug，正常用户的量远小于它。 */
const MAX_PAGES = 20

async function fetchAllPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchPage(cursor)
    items.push(...response.items)
    if (response.nextCursor === null) return { items, truncated: false }
    // 游标没前进 = 服务端在重复给同一页，再收会让列表翻倍、React 的 key 还会撞车
    if (response.nextCursor === cursor) return { items, truncated: true }
    cursor = response.nextCursor
  }
  return { items, truncated: true }
}

export default function History() {
  const authStatus = useAuthGuard()
  const userId = useAuth().user?.id ?? null

  /**
   * 演示构建才摆演示数据：开关口径是 `MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`
   * （**不能**只认前一个 —— `dev:weapp` 的日常开发也满足它，会顶掉真实空态）。
   */
  const demo = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

  const [tab, setTab] = useState<HistoryTab>('history')
  const [data, setData] = useState<DemoRecords | null>(null)
  /** 演示构建的首屏加载态（真实构建这一支不用它，走下面的 `realLoading`） */
  const [loading, setLoading] = useState(demo)
  const [showTop, setShowTop] = useState(false)
  /** 重拉（下拉刷新）：自增即驱动下面的 effect（演示与真实浏览档共用同一个 token） */
  const [reloadToken, setReloadToken] = useState(0)

  /**
   * 真实构建 · **浏览档**的取数结果（演示构建恒为 null；收藏 / 留言两档各有自己的
   * `realFavs` / `realMsgs`，见下）。
   * `ownerId` 与 `DemoRecords.ownerId` 同一用意：只收当前账号的结果。
   */
  const [realHistory, setRealHistory] = useState<RealHistory | null>(null)
  /** 真实当前档首屏在途（**三档共用**）。初值 `!demo`：真实构建进来第一帧就该是骨架屏 */
  const [realLoading, setRealLoading] = useState(!demo)
  /** 真实当前档这次没读出来（只在手里没有数据时上屏错误态，见 `realFailed`） */
  const [realFetchFailed, setRealFetchFailed] = useState(false)
  /**
   * 本页面实例内清空过**浏览记录**（只用于空态文案：清过 vs 本来就没有）。
   * ⚠️ 这是**浏览档专属**标记（真实构建只有浏览档能清）—— 空态判定里必须按档位收口，
   * 见 `emptyKind`。
   */
  const [realCleared, setRealCleared] = useState(false)
  /** 「加载更多」在途：换按钮文案 + 挡住连点 */
  const [loadingMore, setLoadingMore] = useState(false)

  /**
   * 真实构建 · 收藏档 / 留言档的取数结果（演示构建恒为 null）。
   * `ownerId` 与 `RealHistory` 同一用意：只收当前账号的结果。
   */
  const [realFavs, setRealFavs] = useState<RealList<RecordCell> | null>(null)
  const [realMsgs, setRealMsgs] = useState<RealList<MessageRecord> | null>(null)

  /**
   * 「清空过哪几档」。三个布尔量，**只活在本次页面实例内**。
   *
   * ⚠️ 离开页面再进来就回到「没清过」—— 这是**已知且故意接受**的行为，不是漏做：
   * 清空本该是服务端写（清空足迹 / 取消收藏 / 删留言），而这三个端点一个都没有
   * （证据见文件头），所以现在清掉的只是本页自己那份演示数组。**把「清过了」持久化
   * 下去是错的**：那会让演示数据永久消失、用户没法再看这一页，而真实数据一到
   * 又必须按服务端为准。等端点落地后，这里换成真实调用、并由服务端返回的列表决定显示。
   *
   * 存**原始数据**、在渲染期用 `applyCleared` 过滤，而不是清空时把 `data` 改掉：
   * 后者在下拉刷新重取之后会被整份覆盖回满列表。
   */
  const [clearedState, setClearedState] = useState<ClearedState>({
    ...NOTHING_CLEARED,
    ownerId: null,
  })
  /**
   * 真实浏览档 `realHistory` 的镜像。effect 里判断「这次是首次加载还是刷新 / 切回浏览档」
   * 用它，理由同下面的 `dataRef`（状态进依赖数组会让 effect 自己再触发一轮）。
   * 只在第一页取数落地时更新：它服务的是**账号归属**判断，不必逐页镜像（翻页只会追加）。
   */
  const realRef = useRef<RealHistory | null>(null)
  /** 收藏档 / 留言档的镜像，理由同上（`truncated` 也照样存，切档重进时口径一致） */
  const favsRef = useRef<RealList<RecordCell> | null>(null)
  const msgsRef = useRef<RealList<MessageRecord> | null>(null)
  /**
   * 在飞的真实请求（首屏 / 加载更多）的取消句柄。
   *
   * 两处必须能显式取消，否则结果会交叉追加：
   * 1. 刷新 / 切档 / 换账号 / 卸载 → effect 重跑时作废在飞的**加载更多**（旧游标的那一页
   *    若在刷新之后落地，会与新的第一页重复追加）；
   * 2. 清空成功 → 作废在飞的**首屏**（清空前发出的 GET 若在 DELETE 之后落地，
   *    会把已经清掉的列表又画回来）。
   */
  const pendingFirst = useRef<(() => void) | null>(null)
  const pendingMore = useRef<(() => void) | null>(null)
  /**
   * 这一轮 effect 重跑是不是**下拉刷新**发起的（由 `usePullDownRefresh` 置位）。
   *
   * 取消在飞请求时要收原生下拉指示器，但**刷新不能收**：刷新是「旧的一轮取消、新的一轮
   * 接力」，指示器应当一直转到新结果落地（新一轮的 then / catch 会收）。所以 effect 的
   * cleanup 只在标记为假时收指示器 —— 切档 / 换号 / 卸载这些**没有接力**的取消路径
   * 才不会留下一个空转的圈。
   */
  const refreshPending = useRef(false)
  /**
   * 换账号 / 退出时的**渲染期重置**（与 `pages/mylist` 同款写法）：
   * 「清空过」与真实浏览档的列表都是上一个账号的视角，必须在**同一帧内**清掉 ——
   * 否则新账号一进来会先画一帧「这个账号已经清空了」的空列表 / 上一个账号的足迹。
   * 写成 effect 里 setState 不行，那要到下一帧才生效。
   */
  const [prevScopeUser, setPrevScopeUser] = useState<string | null>(userId)
  if (prevScopeUser !== userId) {
    setPrevScopeUser(userId)
    setClearedState({ ...NOTHING_CLEARED, ownerId: null })
    // 上一个账号的在飞请求当场作废（effect 的 cleanup 也会取消，这里同步再兜一道）
    pendingFirst.current?.()
    pendingMore.current?.()
    pendingFirst.current = null
    pendingMore.current = null
    realRef.current = null
    setRealHistory(null)
    setRealFetchFailed(false)
    setRealCleared(false)
    setLoadingMore(false)
    favsRef.current = null
    setRealFavs(null)
    msgsRef.current = null
    setRealMsgs(null)
    setRealLoading(!demo)
  }
  /**
   * `data` 的镜像。effect 里要判断「手里这份数据是不是当前账号的」来决定
   * 保留列表（下拉刷新）还是换骨架屏（换账号），而 `data` 一旦进依赖数组就会
   * 因为 `setData` 自己再触发一轮，只能走 ref 读。
   */
  const dataRef = useRef<DemoRecords | null>(null)

  useEffect(() => {
    // 真实构建这一支完全不动：不取演示数据、不碰加载态（浏览档的真实取数在下面的 effect；
    // 这里若照旧 `setLoading(false)` + `stopPullDownRefresh`，会把真实下拉刷新的指示器提前收掉）
    if (!demo) return

    const previous = dataRef.current
    /**
     * 这次 effect 是不是**下拉刷新**：`reloadToken > 0` 且手里这份数据仍属于当前账号。
     * 是刷新就保留列表（系统已经拉出原生指示器，再换成骨架屏只会让用户丢掉阅读位置，
     * 先例 `features/transaction/useOrderList` 的 `keepList`）。换账号时 `sameOwner` 为假，
     * 一律按新的一次加载处理。
     */
    const sameOwner = previous !== null && userId !== null && previous.ownerId === userId
    const isRefresh = reloadToken > 0 && sameOwner

    if (!sameOwner) {
      dataRef.current = null
      setData(null)
    }

    if (authStatus !== 'authed' || userId === null) {
      // 未登录 / 登录态未就绪时守卫在跳转，这里也不该亮骨架屏
      setLoading(false)
      // 上一轮挂着的指示器在这里收掉，不能留一个一直转的圈
      void Taro.stopPullDownRefresh()
      return
    }

    if (!isRefresh) {
      setLoading(true)
      void Taro.stopPullDownRefresh()
    }

    const forUserId = userId
    const load = cancellable(
      () => fetchDemoRecords(forUserId),
      (next) => next.ownerId === forUserId,
    )
    void load.promise.then((next) => {
      // 被取消（换账号 / 退出 / 重拉）时 next 为 null：整批结果含加载态一律不动
      if (!next) return
      dataRef.current = next
      setData(next)
      setLoading(false)
      // 原生下拉指示器在本次结果落地时收起
      void Taro.stopPullDownRefresh()
    })
    return load.cancel
  }, [demo, authStatus, userId, reloadToken])

  /**
   * 真实构建 · 浏览档取数（#415 M1）。
   *
   * 只在「真实构建 + 当前档是浏览 + 已登录」时发请求；演示构建与另两档完全保持现状。
   * 与演示 effect 同一套账号作用域口径：`cancellable` + `ownerId` 校验，换账号 / 退出 /
   * 重拉时迟到结果一律丢弃（渲染期重置已经把手里的列表清干净）。
   */
  useEffect(() => {
    // 本轮是不是下拉刷新发起的：上一轮的 cleanup 已经据它决定放行指示器，这里读走后清零
    const refreshRun = refreshPending.current
    refreshPending.current = false
    if (demo) return
    if (tab !== 'history') {
      /*
        切走浏览档：在飞的取数已被上一轮 cleanup 取消，没有新一轮会来收指示器，这里补收。

        ⚠️ 但**下拉刷新**那一次不能收：收藏 / 留言档有自己的取数 effect（声明在本条之后，
        同一次 commit 里最后跑），刷新时由它负责在结果落地时收。这里抢着收会让原生指示器
        在请求发出之前就消失，那两档的刷新就变成「转圈一闪、列表静默换掉」的零反馈。
      */
      if (!refreshRun) void Taro.stopPullDownRefresh()
      return
    }
    if (authStatus !== 'authed' || userId === null) {
      // 未登录 / 登录态未就绪时守卫在跳转，别把骨架屏一直挂着（登录态就绪后本 effect 会重跑）；
      // 换号 / 退出的取消路径同理：没有接力的一轮，指示器在这里收掉
      setRealLoading(false)
      void Taro.stopPullDownRefresh()
      return
    }

    const previous = realRef.current
    const sameOwner = previous !== null && previous.ownerId === userId
    /**
     * 下拉刷新（`reloadToken` 自增）且手里已有当前账号的列表 → 保留列表（系统已经拉出原生
     * 指示器，再换成骨架屏只会让用户丢掉阅读位置，先例 `useOrderList` 的 `keepList`）；
     * 首次进入 / 换账号 / 切档重取才计一次在途 —— 有数据时上面那支也不会画骨架屏。
     */
    const isRefresh = reloadToken > 0 && sameOwner
    if (!isRefresh) setRealLoading(true)
    setRealFetchFailed(false)
    // 在飞的「加载更多」作废：旧游标那一页若在新第一页之后落地，会重复追加同一批行
    pendingMore.current?.()
    pendingMore.current = null
    setLoadingMore(false)

    const forUserId = userId
    const load = cancellable(
      async () => ({ ownerId: forUserId, page: await fetchMyViewHistory() }),
      (next) => next.ownerId === forUserId,
    )
    pendingFirst.current = load.cancel
    void load.promise
      .then((next) => {
        // 被取消（换账号 / 退出 / 重拉 / 清空）时 next 为 null：整份结果一律不动
        if (!next) return
        const record: RealHistory = {
          ownerId: next.ownerId,
          items: next.page.items,
          days: historyDaysOf(next.page.items, Date.now()),
          nextCursor: next.page.nextCursor,
          total: next.page.total,
        }
        realRef.current = record
        setRealHistory(record)
        setRealLoading(false)
        setLoadingMore(false)
        // 原生下拉指示器在本次结果落地时收起
        void Taro.stopPullDownRefresh()
      })
      .catch((error: unknown) => {
        // 取消不是失败：新一轮取数已经接管状态，什么都不改
        if (load.isCancelled()) return
        console.warn('[miniapp] 浏览记录读取失败', error)
        setRealLoading(false)
        setRealFetchFailed(true)
        // 手里已有的列表保留（刷新失败不该把读到的东西抹掉）；没有数据时才上错误态
        void Taro.stopPullDownRefresh()
      })
    return () => {
      load.cancel()
      pendingFirst.current = null
      // 离开浏览档 / 卸载时由 effect 生命周期统一收掉在飞的「加载更多」
      pendingMore.current?.()
      pendingMore.current = null
      /*
        这一轮不是「下拉刷新接力」的取消（切档 / 换号 / 卸载）：没有任何新一轮会来收
        原生指示器，必须在这里收掉，否则会出现「列表已经不转了、顶部还在转」。
        是刷新接力时标记为真 → 放行，交给新一轮的结果落地时收。
      */
      if (!refreshPending.current) void Taro.stopPullDownRefresh()
    }
  }, [demo, tab, authStatus, userId, reloadToken])

  /**
   * 真实构建 · 收藏档 / 留言档取数。
   *
   * 两条读端点早已上线（收藏 #394、`GET /me/comments` #195），但本页此前只把**浏览档**
   * 接了真（#415 M1），另两档一律摆「这一页还没接」的缺口空态 —— 这里把它们接上。
   *
   * 与浏览档**分开一条 effect**：浏览档有自己的「加载更多」游标语义（增量追加 + 按天重新
   * 分组），这两档是**翻页取全**（见 `RealList`），两套状态机混在一起只会互相干扰。
   * 两者的账号作用域口径一致：`cancellable` + `ownerId` 校验，换账号 / 退出 / 重拉时
   * 迟到的结果一律丢弃（渲染期重置已经把手里的列表清干净）。
   */
  useEffect(() => {
    // 与浏览档同款：先读走「下拉刷新」标记，本次分支一律从零开始
    refreshPending.current = false
    if (demo) return
    if (tab === 'history') return
    if (authStatus !== 'authed' || userId === null) {
      setRealLoading(false)
      void Taro.stopPullDownRefresh()
      return
    }

    const mirror = tab === 'favs' ? favsRef : msgsRef
    const sameOwner = mirror.current !== null && mirror.current.ownerId === userId
    /** 下拉刷新且手里已有当前账号的列表 → 保留列表，不换骨架屏（同浏览档的 `isRefresh`） */
    const isRefresh = reloadToken > 0 && sameOwner
    if (!isRefresh) setRealLoading(true)
    setRealFetchFailed(false)

    const forUserId = userId
    const load = cancellable(
      async () => {
        if (tab === 'favs') {
          const page = await fetchAllPages((cursor) => fetchMyFavorites(cursor))
          return { ownerId: forUserId, kind: 'favs' as const, page }
        }
        const page = await fetchAllPages((cursor) => fetchMyComments({ kind: 'all', cursor }))
        return { ownerId: forUserId, kind: 'msgs' as const, page }
      },
      (next) => next.ownerId === forUserId,
    )
    pendingFirst.current = load.cancel
    void load.promise
      .then((next) => {
        // 被取消（换账号 / 退出 / 重拉）时 next 为 null：整份结果一律不动
        if (!next) return
        if (next.kind === 'favs') {
          const record: RealList<RecordCell> = {
            ownerId: next.ownerId,
            rows: next.page.items.map(favoriteCell),
            truncated: next.page.truncated,
          }
          favsRef.current = record
          setRealFavs(record)
        } else {
          const nowMs = Date.now()
          const record: RealList<MessageRecord> = {
            ownerId: next.ownerId,
            rows: next.page.items.map((row) => messageRow(row, nowMs)),
            truncated: next.page.truncated,
          }
          msgsRef.current = record
          setRealMsgs(record)
        }
        setRealLoading(false)
        // 原生下拉指示器在本次结果落地时收起
        void Taro.stopPullDownRefresh()
      })
      .catch((error: unknown) => {
        // 取消不是失败：新一轮取数已经接管状态，什么都不改
        if (load.isCancelled()) return
        console.warn('[miniapp] 收藏 / 留言记录读取失败', error)
        setRealLoading(false)
        setRealFetchFailed(true)
        // 手里已有的列表保留（刷新失败不该把读到的东西抹掉）
        void Taro.stopPullDownRefresh()
      })
    return () => {
      load.cancel()
      pendingFirst.current = null
      // 这一轮不是「下拉刷新接力」的取消（切档 / 换号 / 卸载）：没有新一轮会来收指示器
      if (!refreshPending.current) void Taro.stopPullDownRefresh()
    }
  }, [demo, tab, authStatus, userId, reloadToken])

  /** 当前账号的「已清空」标记（账号对不上时是「都没清过」） */
  const cleared = useMemo(() => clearedOf(clearedState, userId), [clearedState, userId])
  /** 当前档位的记录是否已被清空 */
  const isCleared = cleared[tab]

  /**
   * 上屏的数据 = 取回来的那份**减去清空过的档**。
   *
   * 为什么在渲染期过滤、而不是在清空时把 `data` 改掉：后者在下拉刷新重取之后会被
   * 整份覆盖回满列表 —— 用户会看到「刚清空的东西自己长回来」。
   */
  const shown = useMemo(() => (data === null ? null : applyCleared(data, cleared)), [data, cleared])
  /** 当前档上屏的记录：真实构建走真接口的结果，演示构建走演示数据 */
  const days = !demo && tab === 'history' ? (realHistory?.days ?? []) : (shown?.days ?? [])
  const favs = !demo && tab === 'favs' ? (realFavs?.rows ?? []) : (shown?.favs ?? [])
  const msgs = !demo && tab === 'msgs' ? (realMsgs?.rows ?? []) : (shown?.msgs ?? [])

  /** 当前档位渲染出来的条目数：三档各自的列表长度现算（`history` 是**件数**不是天数） */
  const shownCount =
    tab === 'history'
      ? days.reduce((n, d) => n + d.items.length, 0)
      : tab === 'favs'
        ? favs.length
        : msgs.length

  /**
   * 分页脚的两个输入：条数 + 是否**取全**。
   *
   * - 浏览档的数取服务端 `total`（与「我的」页数字栏同源）；还有下一页时走「加载更多」，
   *   根本不会渲这句；
   * - 收藏 / 留言档是翻页取全，取全了才说「已显示全部」，翻不到底（`truncated`）只报条数；
   * - 演示构建用本地条数，恒算取全。
   */
  const currentRealList = tab === 'favs' ? realFavs : tab === 'msgs' ? realMsgs : null
  const tailCount =
    tab === 'history'
      ? realHistory === null
        ? shownCount
        : realHistory.total
      : (currentRealList?.rows.length ?? shownCount)
  const tailTruncated = currentRealList?.truncated ?? false

  /**
   * 骨架屏只在「还没有数据」时顶替内容（下拉刷新保留了列表，不换骨架屏）。
   * 真实构建三档各自由 `realLoading` 驱动，判据是**当前档**手里还没有数据。
   */
  const realEmptyNow =
    tab === 'history'
      ? realHistory === null
      : tab === 'favs'
        ? realFavs === null
        : realMsgs === null
  const pending = demo ? loading && data === null : realLoading && realEmptyNow

  /** 真实当前档读失败且手里没有数据：上错误态（**不能**用空态冒充「你没有记录」） */
  const realFailed = !demo && realFetchFailed && realEmptyNow

  /**
   * 空态的来由。三档都接了真端点，所以不再有 `noBackend` 这一支：接口成功但列表为空
   * 就是**真的没有记录**，本实例里清过则说「已清空」。
   *
   * ⚠️ `realCleared` 是**浏览档专属**的标记（真实构建只有浏览档能清，见 `canClearTab`），
   * 必须按 `tab === 'history'` 收口：否则「清空浏览记录 → 切到空的收藏档」会说出
   * 「收藏已清空」—— 用户根本没清过收藏，这是无中生有。
   */
  const emptyKind: EmptyKind = emptyKindOf(demo ? isCleared : realCleared && tab === 'history')

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  const toast = (text: string) => {
    void Taro.showToast({ title: text, icon: 'none' })
  }

  /**
   * 下拉刷新：微信原生指示器（`index.config.ts` 的 `enablePullDownRefresh`）。
   * 演示构建重拉一遍演示数据；真实构建**三档都能刷**（各自的读端点在，重取第一页）。
   */
  usePullDownRefresh(() => {
    if (demo) {
      setReloadToken((token) => token + 1)
      return
    }
    if (authStatus === 'authed' && userId !== null) {
      // 标记「这一轮是刷新发起的」：effect 的 cleanup 据此放行原生指示器（新一轮会自己收）
      refreshPending.current = true
      setReloadToken((token) => token + 1)
      return
    }
    // 未登录 / 登录态未就绪：守卫正在跳转，没有可拉的请求，收掉指示器即可
    void Taro.stopPullDownRefresh()
  })

  /**
   * 「加载更多」：游标翻页（真实浏览档）。`nextCursor` 是不透明串，原样回传。
   *
   * 追加的一页必须与已有 `items` **按 id 去重后合并、再重新分组**：同一天可能横跨两页，
   * 直接拼 `days` 会让同一天出现两组、还会撞 `key={day.date}`；而并发写入下后一页可能
   * 重复带回上一页给过的行，不去重就会出现同一件商品两张格（`mergeHistoryItems`）。
   */
  const loadMore = () => {
    const current = realHistory
    if (loadingMore || current === null || current.nextCursor === null) return
    const forUserId = current.ownerId
    setLoadingMore(true)
    const load = cancellable(
      () => fetchMyViewHistory({ cursor: current.nextCursor ?? undefined }),
      () => true,
    )
    pendingMore.current = load.cancel
    void load.promise
      .then((page) => {
        // 被取消（刷新 / 切档 / 换账号 / 清空）或换过账号：整页结果丢弃
        // （下面的 updater 还会再核对一次 ownerId）
        if (load.isCancelled() || page === null) return
        setRealHistory((prev) => {
          if (prev === null || prev.ownerId !== forUserId) return prev
          const items = mergeHistoryItems(prev.items, page.items)
          return {
            ...prev,
            items,
            days: historyDaysOf(items, Date.now()),
            nextCursor: page.nextCursor,
            total: page.total,
          }
        })
        setLoadingMore(false)
      })
      .catch((error: unknown) => {
        if (load.isCancelled()) return
        console.warn('[miniapp] 浏览记录加载更多失败', error)
        setLoadingMore(false)
        toast('没加载出来，请重试')
      })
  }

  /**
   * 顶栏右端「清空」。
   *
   * **演示构建**：清掉当前档的演示记录 —— 列表当场变空、并切到「已清空」空态
   * （`clearedState` 一变，上面那份 `shown` 就跟着空），下拉刷新之后也仍然是空的。
   * **离开页面再进来会回到清空前**（标记只在本次页面实例内，理由见 `clearedState` 的注释）。
   * **真实构建**：只有浏览档能清（`canClearTab`）—— 真发 `DELETE /me/view-history`，
   * 成功后以服务端为准（本地列表清空 + 「已清空」空态）；失败只 toast 服务端文案，
   * **不做任何本地翻转**。收藏 / 留言两档没有清空端点，只给说明。
   */
  const clearTab = () => {
    if (userId === null || !canClearTab(demo, tab)) {
      toast(clearBlockedOf(tab))
      return
    }
    // 演示构建：清掉本页自己那份演示记录（列表当场变空 + 切到「已清空」空态）
    if (demo) {
      setClearedState((prev) => withCleared(prev, userId, tab))
      toast(clearDoneOf(tab))
      return
    }
    /*
      真实构建只有浏览档能走到这里（`canClearTab`）：真发 `DELETE /me/view-history`。
      成功以服务端为准 —— 本地列表清空 + 切「已清空」空态（下拉刷新重取第一页仍是空）；
      失败只 toast 服务端文案，**不做任何本地翻转**（本地删几行再回滚是假接线，
      会让用户以为删成功了）。
    */
    void (async () => {
      try {
        await clearMyViewHistory()
        // 清空前发出的 GET / 加载更多若在 DELETE 之后落地，会把已清掉的列表又画回来 ——
        // 先显式作废在飞请求，再以服务端为准把本地置空。
        pendingFirst.current?.()
        pendingMore.current?.()
        pendingFirst.current = null
        pendingMore.current = null
        realRef.current = null
        setRealHistory(null)
        setRealFetchFailed(false)
        setRealCleared(true)
        setRealLoading(false)
        setLoadingMore(false)
        // 清空也作废了在飞的取数：没有结果会来收原生指示器（刷新中清空也走这条），这里收掉
        void Taro.stopPullDownRefresh()
        toast(clearDoneOf(tab))
      } catch (error) {
        toast(error instanceof Error && error.message ? error.message : '清空失败，请重试')
      }
    })()
  }

  /** 切档位：回到顶部（否则从长列表切到短列表会停在半空） */
  const pickTab = (key: HistoryTab) => {
    setTab(key)
    void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })
  }

  /**
   * 演示格 / 留言行：演示 id 在库里不存在，跳过去必然 404 —— 给明确的演示说明，
   * 不假装跳转成功，也不跳到必然 404 的页面（方案 §2.3）。
   */
  const openDemoRecord = () => {
    toast(DEMO_OPEN_TIP)
  }

  /**
   * 真实浏览档的格子：进真实商品详情。
   *
   * 失效件与收藏页同口径（`pages/favorites` 的 `openItem`）：详情页对已下架 / 已卖掉的商品
   * 仍是「还能买」的口吻，与格上的角标自相矛盾 —— 所以只 toast 失效原因，不跳。
   */
  const openRealRecord = (item: RecordCell) => {
    if (item.gone) {
      toast(`这件宝贝${item.gone}了`)
      return
    }
    void Taro.navigateTo({ url: `/pkg-browse/pages/listing-detail/index?id=${item.id}` })
  }

  /**
   * 真实留言行：按契约给的目标跳转（不靠标题猜 id）。
   * 留言 → 商品详情；评价 → 那笔交易的面交页。演示行没有 `target`，走演示说明。
   */
  const openRealMsg = (item: MessageRecord) => {
    const target = item.target
    if (target === undefined) {
      openDemoRecord()
      return
    }
    if (target.kind === 'transaction') {
      void Taro.navigateTo({ url: `/pkg-trade/pages/transaction-meetup/index?id=${target.id}` })
      return
    }
    void Taro.navigateTo({ url: `/pkg-browse/pages/listing-detail/index?id=${target.id}` })
  }

  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /** 三列格（全部浏览 / 我收藏的共用）：方形色块 + 品类小字 + 失效遮罩 + 格下价格 */
  const renderCell = (item: RecordCell, onOpen: (cell: RecordCell) => void) => (
    <View key={item.id} className="hist__cell">
      <View className={`hist__thumb${item.gone ? ' is-gone' : ''}`} onClick={() => onOpen(item)}>
        <Image className="hist__thumb-img" src={blockUrlOf(item.category)} mode="aspectFill" />
        <Text className="hist__ttag">{shortLabelOf(item.category)}</Text>
        {item.gone ? <Text className="hist__tgone">{item.gone}</Text> : null}
      </View>
      <Text className="hist__price num">
        <Text className="hist__price-cur">¥</Text>
        {formatAmount(item.priceCents)}
      </Text>
    </View>
  )

  return (
    <View className="hist">
      {/* 顶部冰蓝渐变圆角背景（稿 `.pagehead` 的 --grad-page + 下缘 32pt 圆角） */}
      <View className="hist__bg" />

      {/*
        顶栏（Owner 2026-09-23 定版，照消息页）：`components/top-bar` 的 glass 变体 ——
        返回钮 + 两段式标题（「历史」走 --fg、「浏览」走品牌蓝）+ 右端「清空」，
        三档 tab 作为**副行**并入同一块玻璃（`below`），内容从底下滚过。

        为什么不再用 `components/nav-bar`：那个是**漂浮**导航（只有返回钮是实体），
        放不下页面自己的动作；本页现在右端有「清空」，需要的是消息页那种
        「固定 + 玻璃底 + 副行」的栏。
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
        /*
          「清空」**放在中槽、靠右对齐**，而不是放在 `actions` 槽。
          原因：`components/top-bar` 的 `.topbar__row` 是普通 flex（只有 `gap` 与
          `padding-left`），`.topbar__actions` 是 `flex: 0 0 auto` 且**没有**
          `margin-left: auto` —— 页面又不传 `center` 时，标题与动作会**并排挤在左边**
          （实测 750rpx 帧里按钮右缘离可用右边界还差约 240rpx），不是 Owner 要的
          「贴近右边」。中槽的 `.topbar__center` 本身就是 `flex: 1 1 auto`，
          给它的内容加 `justify-content: flex-end` 就能把按钮顶到行尾，
          且右侧避让（原生胶囊）仍由组件下发的 `paddingRight` 统一负责 ——
          不必改 `components/**`（本轮白名单不允许）。
        */
        center={
          <View className="hist__navacts">
            <View className="hist__clear" onClick={clearTab}>
              <Text>{CLEAR_LABEL}</Text>
            </View>
          </View>
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
        ) : realFailed ? (
          /*
            真实浏览档读失败：**不能用空态冒充** —— 空列表是「你真的没有浏览记录」，
            读失败是「这次没读到」；混在一起会让用户以为自己的足迹丢了。给重试出口。
          */
          <LoadError
            title={`${recordNameOf(tab)}没读出来`}
            text="检查网络后重试"
            onRetry={() => setReloadToken((token) => token + 1)}
          />
        ) : shownCount === 0 ? (
          /*
            空态按来由分开说（`emptyKind`）：三档都接了真端点，所以只有两种 ——
            没清过 → 「还没有 X」（空就是真的空）；刚清过 → 「已清空」。
          */
          <EmptyState
            title={emptyCopyOf(tab, emptyKind).title}
            text={emptyCopyOf(tab, emptyKind).text}
            actionText={emptyCopyOf(tab, emptyKind).action}
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
                    <View className="hist__grid">
                      {day.items.map((item) =>
                        renderCell(item, realHistory === null ? openDemoRecord : openRealRecord),
                      )}
                    </View>
                  </View>
                ))
              : null}

            {tab === 'favs' ? (
              /* 我收藏的：三列格（失效角标与收藏页同源，稿决策⑥）。
                 真实数据下点格进商品详情；演示行仍走演示说明 */
              <View className="hist__grid">
                {favs.map((item) =>
                  renderCell(item, realFavs === null ? openDemoRecord : openRealRecord),
                )}
              </View>
            ) : null}

            {tab === 'msgs' ? (
              /* 我留言的：整宽行 —— 缩略图 + 标题 + 类型胶囊 + 我那句话（2 行）+ 时间。
                 刻意**不显示价格**（稿决策④：这一档找的是「我当时说了什么」）。
                 评价行没有品类（交易 DTO 内嵌的商品摘要不带分类）→ 不画品类小字、色块退 OTHER。 */
              <View className="hist__rows">
                {msgs.map((item) => (
                  <View
                    key={item.id}
                    className="hist__row"
                    onClick={() => (realMsgs === null ? openDemoRecord() : openRealMsg(item))}
                  >
                    <View className="hist__rthumb">
                      <Image
                        className="hist__rthumb-img"
                        src={blockUrlOf(item.category ?? 'OTHER')}
                        mode="aspectFill"
                      />
                      {item.category === null ? null : (
                        <Text className="hist__rthumb-tag">{shortLabelOf(item.category)}</Text>
                      )}
                    </View>
                    <View className="hist__rmain">
                      <View className="hist__rtop">
                        <Text className="hist__rtitle">{item.title}</Text>
                        <Text className={`hist__rkind${item.kind === 'review' ? ' is-trade' : ''}`}>
                          {MESSAGE_KIND_LABEL[item.kind]}
                        </Text>
                      </View>
                      <Text className="hist__rtext">{item.text}</Text>
                      <Text className="hist__rtime">{item.timeLabel}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {/* 底部说明：只有浏览档有（收藏档原有一条「已降价」说明，角标删了之后不成立） */}
            {noteOf(tab) ? <Text className="hist__note">{noteOf(tab)}</Text> : null}

            {/*
              分页脚：真实浏览档还有下一页（`nextCursor !== null`）就给「加载更多」（在途禁用），
              到底（或演示）才显示现有的「已显示全部」。真实浏览档的数取服务端 `total`
              （与「我的」页数字栏同源）；演示用本地条数。
              收藏 / 留言两档是**翻页取全**，取全了才能说「已显示全部」；翻不到底
              （`truncated`）只报条数 —— 说了「全部」而其实没取完就是假话。
            */}
            {tab === 'history' && realHistory !== null && realHistory.nextCursor !== null ? (
              <View className="hist__tail" onClick={loadMore}>
                <View className="hist__tail-line" />
                <Text className="hist__tail-tx num">{loadingMore ? '加载中…' : '加载更多'}</Text>
                <View className="hist__tail-line" />
              </View>
            ) : (
              <View className="hist__tail">
                <View className="hist__tail-line" />
                <Text className="hist__tail-tx num">
                  {tailTextOf(tab, tailCount, tailTruncated)}
                </Text>
                <View className="hist__tail-line" />
              </View>
            )}
          </View>
        )}
      </View>

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
