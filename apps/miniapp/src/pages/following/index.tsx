import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchMyFollowing, setFollow } from '@/features/following/api'
import {
  demoReady,
  dtoRow,
  FOLLOW_DEMO_LATENCY_MS,
  type FollowingReady,
  type FollowingRow,
  followingMode,
  mergeFollowingPage,
  removeFollowingRow,
} from '@/features/following/load'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { cancellable } from '@/lib/cancellable'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isUnauthenticatedError } from '@/lib/request'
import './index.scss'

/**
 * 我的关注（设计稿 `小程序1版following.html`）。入口在「我的」页数字栏第三格。
 *
 * ## 数据（#188 接线后的口径，见 `features/following/load.ts` 的文件头）
 *
 * - **演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`）→ 照稿的 5 个人，
 *   列表上方**明写这是演示数据**，行点击给演示说明（fixture 的 id 不是真实用户）。
 * - **其余一切构建（含生产）** → `GET /me/following` 真接口：真实有数据就是列表，
 *   真实无数据就是空态，请求失败是**错误态 + 重试**。**生产不退演示**。
 *
 * ## 分页与计数
 *
 * 一页 20 条，页脚有「加载更多」；`nextCursor === null` 才是到底（不能用「这一页不满」
 * 推断）。顶部「关注 N 人 · 互粉 M 人」取**服务端的全量计数**（不是这一页的行数）——
 * 拿分页列表的长度冒充总数会让数字随滚动跳动。
 *
 * ## 关系钮不伪造状态
 *
 * 「互粉 / 已关注」按服务端真值渲染，点击走**确认 → 取关**（成功以服务端回包为准，
 * 不在本地翻转）。演示态下这颗钮只给说明，不发请求。
 *
 * ## 行内只展示有数据源的字段
 *
 * 真实行只出 昵称 / 头像 / 认证状态（公开投影的字段子集）；演示行额外有稿里的
 * 个性签名与最近活跃。**不显示校区与院系**（#86：产品整体不采集、不公开）。
 *
 * ## 「关注动态」是状态页
 *
 * 没有动态流的数据源。这一档如实写成「未上线」状态页，**不编一屏假动态**（稿决策③）。
 * 稿里第三档「兴趣圈」已被 Owner 删除（决策④），不恢复。
 */

/** 两档下划线 tab：关注的人 / 关注动态（稿决策②） */
type FollowingTab = 'people' | 'feed'

const TABS: { key: FollowingTab; label: string }[] = [
  { key: 'people', label: '关注的人' },
  { key: 'feed', label: '关注动态' },
]

/** 取数模式：构建期常量 `__ALLOW_MOCK_FALLBACK__` / `__DEMO_AUTH__` 在打包时就定死了。 */
const MODE = followingMode(MOCK_FALLBACK_ENABLED, DEMO_AUTH_ENABLED)

/**
 * 页面加载状态。`ready` 且 `rows` 为空 = **真实的空列表**（不是错误，也不是演示）；
 * 错误单独一档，页面必须说「没加载出来」，不能拿空态冒充「恰好没有关注的人」。
 */
type FollowingLoad = { kind: 'loading' } | { kind: 'error' } | FollowingReady

export default function Following() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null

  /**
   * 顶栏栅格（状态栏高 / 内容行高）。**必须来自 `lib/nav-metrics` 的运行时反推**，
   * 不能照抄稿的固定值：真机上胶囊位置逐机不同。
   */
  const metrics = useMemo(() => readNavMetrics(), [])

  const [tab, setTab] = useState<FollowingTab>('people')
  const [load, setLoad] = useState<FollowingLoad>({ kind: 'loading' })
  /**
   * `useDidShow` 的触发计数（`null` = 还没显示过，与 `pages/watchers` 同一手法）。
   *
   * 取数**只由这一条驱动**：进页时触发一次，从他人主页（本页点进去的 `/pages/user`）
   * 返回时再触发一次 —— 那边可能刚关注 / 取关过，不重拉就会显示过期的列表与计数
   * （验收：关注/取关与计数同源、重进状态一致）。登录态变化（`authStatus` / `userId`）
   * 也让同一个 effect 重跑，所以冷启动恢复到已登录时同样会取数。
   */
  const [showToken, setShowToken] = useState<number | null>(null)
  const [showTop, setShowTop] = useState(false)
  /** 页脚「加载更多」在飞；`moreError` 是这一页失败（列表本身仍是好的，不整页报错）。 */
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  /** 正在取关的那一行（`null` = 没有在飞的关系写操作）。 */
  const [busyId, setBusyId] = useState<string | null>(null)

  /**
   * 在飞的取数 / 写操作的序号。**账号一变就自增**：旧回包据此丢弃，不让上一账号的
   * 「加载更多失败」「取关成功」落到新账号的界面上（验收：迟到任务与旧 finally 不串号）。
   */
  const accountSeq = useRef(0)

  /**
   * 账号切换的**渲染期清场**（adjust-state-during-render，与 `pages/mylist`、
   * `features/transaction/useOrderList` 同一手法）：本页实例会被压在页面栈里跨登录态存活，
   * 换账号 / 退出回来时，上一帧的列表与档位都属于上一个账号，必须在**同一个 commit 内**
   * 清成「未加载」。写成 effect 里 setState 要到下一帧才生效，会露出一帧旧账号的数据。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    setLoad({ kind: 'loading' })
    setTab('people')
    setLoadingMore(false)
    setMoreError(false)
    setBusyId(null)
    // 作废在飞的回包（见 `accountSeq` 的说明）：旧账号的结果不能再写新账号的状态。
    accountSeq.current += 1
  }

  /**
   * 在飞的那一轮取数（列表首屏 / 加载更多）。换账号 / 退出 / 卸载时由生命周期显式
   * `cancel()`，迟到结果一律丢弃 —— 只比对响应里的 id 不够（见 `lib/cancellable` 的说明）。
   */
  const pending = useRef<(() => void) | null>(null)
  /** 「加载更多」那一发（与首屏分开持有：它不该顶掉首屏的取消句柄，见审查发现 M1）。 */
  const pendingMore = useRef<(() => void) | null>(null)

  /** 首屏取数。演示构建走 fixture（带一点延迟让骨架屏看得见），其余走真接口。 */
  const loadFirstPage = useCallback(async (): Promise<FollowingLoad> => {
    if (MODE === 'demo') {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_DEMO_LATENCY_MS))
      return demoReady()
    }
    try {
      const page = await fetchMyFollowing()
      return {
        kind: 'ready',
        rows: page.items.map(dtoRow),
        total: page.total,
        mutualTotal: page.mutualTotal,
        nextCursor: page.nextCursor,
        demo: false,
      }
    } catch (error) {
      // 未登录（401）不是"加载失败"，但守卫已经在跳登录页；这里统一进错误态，重试即可。
      console.debug('[miniapp] 我的关注：首屏取数失败', error)
      return { kind: 'error' }
    }
  }, [])

  const runLoad = useCallback(async (): Promise<void> => {
    pending.current?.()
    pendingMore.current?.()
    setLoadingMore(false)
    setMoreError(false)
    // 首屏才摆骨架屏：已有列表时（下拉刷新 / 从他人主页返回）保留旧列表，
    // 等新的一页到了再整体替换，避免每回一次子页就闪一帧骨架。
    setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    const seq = accountSeq.current
    const run = cancellable(loadFirstPage, () => true)
    pending.current = run.cancel
    const next = await run.promise
    // 换账号 / 退出后到达的旧结果一律丢弃，不写进新账号的界面（验收：迟到任务不串状态）
    if (accountSeq.current !== seq) return
    if (next) setLoad(next)
  }, [loadFirstPage])

  /** `useDidShow`：进页 + 每次从子页返回都重拉（见 `showToken` 的说明）。 */
  useDidShow(() => setShowToken((value) => (value ?? 0) + 1))

  useEffect(() => {
    // 还没显示过 / 未登录 / 登录态未就绪：不发请求（守卫在跳转）。
    if (showToken === null || authStatus !== 'authed' || userId === null) return
    void runLoad()
    return () => {
      pending.current?.()
      pendingMore.current?.()
      pending.current = null
      pendingMore.current = null
    }
  }, [showToken, authStatus, userId, runLoad])

  /**
   * 下拉刷新用**微信原生**（`index.config.ts` 的 `enablePullDownRefresh: true`）。
   * 演示构建没有请求可发，刷新**不弹「已刷新」之类的成功提示** —— 那会声称一件没发生的事。
   */
  usePullDownRefresh(() => {
    void runLoad().then(() => Taro.stopPullDownRefresh())
  })

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  /** 页脚「加载更多」：只在 `nextCursor !== null` 时出现，失败只影响这一页（不整页报错）。 */
  const loadMore = async () => {
    if (load.kind !== 'ready' || load.nextCursor === null || loadingMore) return
    const seq = accountSeq.current
    setLoadingMore(true)
    setMoreError(false)
    const run = cancellable(
      () => fetchMyFollowing(load.nextCursor ?? undefined),
      () => true,
    )
    pendingMore.current = run.cancel
    const page = await run.promise.catch((error: unknown) => {
      console.debug('[miniapp] 我的关注：加载更多失败', error)
      return null
    })
    // 换账号了：旧结果一律丢弃，不动新账号的状态
    if (accountSeq.current !== seq) return
    // **被新一轮取数取消**（下拉刷新 / 从他人主页返回时 runLoad 会 cancel 这一发）：
    // `cancellable` 对「取消」与「失败」都给 null，不区分就会把一次正常刷新渲染成
    // 页脚的「没加载出来 · 重试」。取消不是失败，什么都不改（新一轮已接管状态）。
    if (run.isCancelled()) return
    setLoadingMore(false)
    if (!page) {
      setMoreError(true)
      return
    }
    setLoad((prev) => (prev.kind === 'ready' ? mergeFollowingPage(prev, page) : prev))
  }

  /**
   * 行点击：真实数据跳真实他人主页；演示态的 id（`P01`…）在库里不存在，跳过去必然 404，
   * 所以给**明确的演示说明**，不假装跳成功。
   */
  const openPerson = (row: FollowingRow) => {
    if (load.kind !== 'ready' || load.demo) {
      toast(`演示数据：${row.nickname} 的主页不可打开`)
      return
    }
    void Taro.navigateTo({ url: `/pages/user/index?id=${encodeURIComponent(row.id)}` })
  }

  /** 取关：成功以服务端回包为准，本地只在成功后移除该行；失败保留原状并提示。 */
  const runUnfollow = async (row: FollowingRow) => {
    const seq = accountSeq.current
    setBusyId(row.id)
    const run = cancellable(
      () => setFollow(row.id, false),
      () => true,
    )
    const next = await run.promise.catch((error: unknown) => {
      if (accountSeq.current !== seq) return null
      console.debug('[miniapp] 我的关注：取关失败', error)
      toast(isUnauthenticatedError(error) ? '登录已失效，请重新登录' : '取关失败，请重试')
      return null
    })
    if (accountSeq.current !== seq) return
    setBusyId(null)
    if (!next) return
    // 服务端说还关注着（不该发生）：不动列表，让用户看到真值而不是本地猜测。
    if (next.following) return
    setLoad((prev) =>
      prev.kind === 'ready' && !prev.demo ? removeFollowingRow(prev, row.id) : prev,
    )
  }

  const manageRelation = (row: FollowingRow) => {
    if (load.kind !== 'ready' || load.demo) {
      toast('演示数据：关注管理不可操作')
      return
    }
    if (busyId !== null) return
    void Taro.showModal({
      title: '取消关注',
      content: `不再关注 ${row.nickname}？`,
      confirmText: '取消关注',
      cancelText: '再想想',
    }).then((res) => {
      if (res.confirm) void runUnfollow(row)
    })
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /** 未登录 / 登录态未就绪：守卫在跳转，这里同时拦住渲染，避免跳转落地前先画一帧 */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  const ready = load.kind === 'ready' ? load : null

  return (
    <View className="fw">
      <View className="fw__bg" />

      {/* 顶栏主行 + 两档 tab 副行：同一块玻璃，钉在顶部 */}
      <TopBar
        variant="glass"
        spacer
        back
        center={
          <View
            className="fw__navtitle"
            style={{
              top: `${metrics.statusBarHeight}px`,
              height: `${metrics.contentHeight}px`,
            }}
          >
            <Text>我的</Text>
            <Text className="fw__navtitle-em">关注</Text>
          </View>
        }
        below={
          <View className="fw__tabs">
            {TABS.map((item) => (
              <View
                key={item.key}
                className={`fw__tab fw__tab--${item.key}${tab === item.key ? ' is-on' : ''}`}
                onClick={() => setTab(item.key)}
              >
                <Text>{item.label}</Text>
              </View>
            ))}
          </View>
        }
      />
      {/* 副行占位：`top-bar` 的 `spacer` 只含主行，tab 行这一截由页面自己补 */}
      <View className="fw__header-gap" />

      {tab === 'feed' ? (
        /* 「关注动态」：没有数据源 → 状态页如实说明，不编一屏假动态（稿决策③） */
        <View className="fw__state">
          <View className="fw__state-disc">
            <Image className="fw__state-ic" src={ICONS.rank} mode="aspectFit" />
          </View>
          <Text className="fw__state-title">关注动态</Text>
          <Text className="fw__state-tag">未上线</Text>
          <Text className="fw__state-text">
            上线后这里会是 TA 们的上架与成交动态。现在还没有这个数据源。
          </Text>
          <View className="fw__state-go" onClick={() => setTab('people')}>
            <Text>先看关注的人</Text>
          </View>
        </View>
      ) : load.kind === 'loading' ? (
        <View className="fw__list">
          {[0, 1, 2].map((i) => (
            <View key={`sk-${i}`} className="fw__skel">
              <View className="fw__skel-av" />
              <View className="fw__skel-col">
                <View className="fw__skel-bar" style={{ width: '34%' }} />
                <View className="fw__skel-bar" style={{ width: '62%' }} />
                <View className="fw__skel-bar" style={{ width: '46%' }} />
              </View>
              <View className="fw__skel-rel" />
            </View>
          ))}
          <View className="fw__skel-hint">
            <View className="fw__spin" />
            {/* 演示构建这一帧是真的在读（本地 fixture + 延迟）；真实构建是在等接口 */}
            <Text>{MODE === 'demo' ? '正在加载演示数据…' : '正在读取关注列表…'}</Text>
          </View>
        </View>
      ) : load.kind === 'error' ? (
        /* 真实接口失败：**不拿空态冒充**「恰好没有关注的人」，给重试入口 */
        <View className="fw__emptypad">
          <LoadError onRetry={() => void runLoad()} />
        </View>
      ) : ready && ready.rows.length === 0 ? (
        /*
          真实的空列表。用户可见文案一律用产品语言（「契约」「端点」只留在注释里）。
          现在他人主页的关注钮是真的（#188 接线），所以「去别人的主页点关注」是
          一条能兑现的指引，不是空承诺。
        */
        <View className="fw__emptypad">
          <EmptyState
            icon={ICONS.personAdd}
            title="还没有关注的人"
            text="去别人的主页点「关注」，TA 就会出现在这里。"
            actionText="去首页看看"
            onAction={() => void Taro.switchTab({ url: '/pages/home/index' })}
          />
        </View>
      ) : ready ? (
        <>
          {/* 演示态必须**可辨认**：条数用 `ready.total` 现算，不写死「5 人」 */}
          {ready.demo ? (
            <View className="fw__demo">
              <View className="fw__demo-ic">
                <Image className="fw__demo-ic-img" src={ICONS.info} mode="aspectFit" />
              </View>
              <Text className="fw__demo-tx">
                {`演示数据：下面这 ${ready.total} 人是设计稿的示例。`}
              </Text>
            </View>
          ) : null}

          <View className="fw__stat">
            <Text>
              关注 <Text className="fw__stat-num num">{ready.total}</Text> 人
            </Text>
            <View className="fw__stat-dot" />
            <Text>
              互粉 <Text className="fw__stat-num num">{ready.mutualTotal}</Text> 人
            </Text>
          </View>

          <View className="fw__list">
            {ready.rows.map((row) => (
              <View key={row.id} className="fw__row">
                <View className="fw__av" onClick={() => openPerson(row)}>
                  {/*
                    真实头像**独占整圆**（`fw__av-photo`），首字不叠上去 —— 把人脸压上一个
                    字母是明确的错误（`demo.ts` 的字段说明记的就是这个坑）。只有演示占位
                    色块（`placeholderBlock`）才与首字叠成两层；没有图时退昵称首字。
                  */}
                  {row.avatarUrl ? (
                    <Image className="fw__av-photo" src={row.avatarUrl} mode="aspectFill" />
                  ) : (
                    <>
                      {row.placeholderBlock ? (
                        <Image
                          className="fw__av-img"
                          src={row.placeholderBlock}
                          mode="aspectFill"
                        />
                      ) : null}
                      <Text className="fw__av-tx">{row.nickname.slice(0, 1)}</Text>
                    </>
                  )}
                </View>

                <View className="fw__main">
                  <View className="fw__top">
                    <Text className="fw__name" onClick={() => openPerson(row)}>
                      {row.nickname}
                    </Text>
                    {/* 认证勾：未认证时整块不占位 */}
                    {row.verified ? (
                      <Image className="fw__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
                    ) : null}
                  </View>
                  {/* 签名 / 最近活跃只有演示稿有数据源；真实行为空串，整行不渲染 */}
                  {row.bio ? <Text className="fw__bio">{row.bio}</Text> : null}
                  {row.seenLabel ? <Text className="fw__seen num">{row.seenLabel}</Text> : null}
                </View>

                {/* 互粉（品牌浅底）/ 已关注（中性描边）：两态必须区分；点击走确认 → 取关 */}
                <View
                  className={`fw__rel${row.mutual ? ' is-mutual' : ''}${
                    busyId === row.id ? ' is-busy' : ''
                  }`}
                  onClick={() => manageRelation(row)}
                >
                  <Text>{row.mutual ? '互粉' : '已关注'}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* 分页脚：`nextCursor !== null` 才出现；这一页失败只在这里提示重试，不推翻已看到的列表 */}
          {ready.nextCursor !== null || moreError ? (
            <View className="fw__more">
              <View className="fw__more-btn" onClick={() => void loadMore()}>
                <Text>
                  {moreError ? '没加载出来 · 重试' : loadingMore ? '正在加载…' : '加载更多'}
                </Text>
              </View>
            </View>
          ) : null}

          <Text className="fw__note">
            {ready.demo
              ? '只展示对方愿意公开的信息：昵称、个性签名与最近活跃时间。'
              : '只展示对方公开的信息：昵称、头像与认证状态。'}
          </Text>
        </>
      ) : null}

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
