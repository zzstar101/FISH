import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { deleteMyComment, fetchMyComments } from '@/features/comments/api'
import { DEMO_COMMENTS_ENABLED } from '@/features/comments/load'
import {
  type CommentSegment,
  countBySegment,
  DEMO_MY_COMMENTS,
  emptyStateOf,
  filterBySegment,
  kindLabel,
  kindOfSegment,
  type MyComment,
  type MyCommentDeleteRef,
  ratingChipOf,
  SEGMENTS,
  shortCategoryLabel,
  toMyCommentFromResponseItem,
  viewTargetOf,
} from '@/features/comments/mine'
import { deleteMyTransactionReview } from '@/features/transaction/api'
import { formatAmount } from '@/lib/money'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import { LISTING_BLOCKS } from '@/mock/blocks'
import './index.scss'

/**
 * 「我的评论」（`小程序1版comments.html`）。#195 接线：真实构建消费 `GET /me/comments`。
 *
 * ## 数据流（真实构建）
 *
 * 分段 = 契约的 `kind` 档位（全部 = `all` 跨表合并 / 商品留言 = `comment` / 交易评价 =
 * `review`），一段一份游标分页列表，触底续页。胶囊计数来自服务端 `total`（同 kind
 * 口径的**全量**数）：进页时用两个 `limit=1` 的探测请求拿「商品留言 / 交易评价」两个
 * 总数，「全部」= 二者之和（契约保证 `kind=all` 的 `total` 就是这个和）；当前段的
 * 响应回来后再以它的 `total` 为准校准。**不**用删除响应的 `deleted` 减计数 ——
 * 那个数字含被级联的他人回复，减出来必漂（契约 `CommentDeleteResponseSchema` 的警告），
 * 删除后一律重拉列表与探测。
 *
 * ## 演示构建
 *
 * 两个开关都开（`features/comments/load`）才读 fixture，不发任何请求；界面上有
 * 「演示数据」说明带，行的跳转/删除给说明 toast（演示 id 在库里不存在、也没有可写的端点）。
 * 真实构建请求失败是**错误态 + 重试**，不回演示。
 *
 * ## 三段互斥 → 才给计数
 *
 * 全部 = 商品留言 ∪ 交易评价，三个数能互相对上，所以计数摆在胶囊上（与我的发布同一判据）。
 *
 * ## 删除长在每一行上，没有「管理」批量入口
 *
 * 评论是**逐条**的东西。留言删除会级联删掉它下面的回复（含别人的），评价删除撤掉
 * 这条成交证据 —— 弹窗文案按行类型说清楚，不做本地假删除，成功后以服务端重拉为准。
 */

/** 缩略图：真实封面优先，无图（或演示行）退回分类基色块（色值来自 mock 的演示色块，不是新增色值） */
function blockOf(category: MyComment['category']): string {
  const set = category !== null ? LISTING_BLOCKS[category] : undefined
  return set?.[0] ?? (LISTING_BLOCKS.OTHER as [string, string, string])[0]
}

/** 三档评分胶囊的文案直接在渲染期取（`ratingChipOf`），这里只给它类型。 */
type SegmentCounts = { all: number | null; listing: number | null; trade: number | null }

const NO_COUNTS: SegmentCounts = { all: null, listing: null, trade: null }

export default function MyComments() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null
  /**
   * 顶栏栅格（状态栏高 / 内容行高），给居中标题定「与胶囊同行」的那条水平带。
   * **必须来自 `lib/nav-metrics` 的运行时反推**，不能照抄稿的固定值：真机上胶囊
   * 位置逐机不同，稿里那个是画出来的假胶囊。
   */
  const metrics = useMemo(() => readNavMetrics(), [])

  /** 演示构建整页读 fixture（口径见 `features/comments/load`），真实构建走接口。 */
  const demo = DEMO_COMMENTS_ENABLED

  const [items, setItems] = useState<MyComment[]>(demo ? DEMO_MY_COMMENTS : [])
  const [loading, setLoading] = useState(!demo)
  const [error, setError] = useState<string | null>(null)
  const [segment, setSegment] = useState<CommentSegment>('all')
  /**
   * 当前段的 ref：`usePullDownRefresh` / 删除回调都是**注册期一次**的闭包或跨帧回调，
   * 直接读 `segment` 会拿到注册那一刻的旧值（切过段后刷新/删除就打错段）。
   * 与本页 `authedRef` 同一手法。
   */
  const segmentRef = useRef<CommentSegment>('all')
  segmentRef.current = segment
  /**
   * 当前账号的 ref（与 `segmentRef` 同一手法）。
   *
   * 列表有 `loadEpoch` 代次守卫，但**计数探测**（`probeCounts`）是一次性发出的聚合读，
   * 回来时页面上可能已经换成另一个账号 —— 它没有自己的代次，只能比账号：拿 A 的 total
   * 写进 B 的胶囊是跨账号串数据（只泄漏聚合数字，但口径与「换号整批丢弃」不符）。
   */
  const userIdRef = useRef<string | null>(userId)
  userIdRef.current = userId
  const [showTop, setShowTop] = useState(false)

  /** 真实模式的续页游标（`nextCursor`；`null` = 到底了）。 */
  const [cursor, setCursor] = useState<string | null>(null)
  /**
   * 续页在飞。**重入守卫必须走 ref**（`loadingMoreRef`）：state 更新要到下一帧才可读，
   * 两个触底事件落进同一渲染帧时都会读到 `false`、各发一份同 cursor 的请求 ——
   * 列表翻倍 + key 撞车（与 `pages/listing-detail` 的在飞锁同一教训）。state 只留给渲染。
   */
  const loadingMoreRef = useRef(false)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 服务端三段计数（真实模式）；演示模式用 `countBySegment` 本地现算。 */
  const [counts, setCounts] = useState<SegmentCounts>(NO_COUNTS)
  /** 删除在飞行标记（行按钮转圈 / 挡连点）。 */
  const [deletingId, setDeletingId] = useState<string | null>(null)

  /**
   * 账号作用域：评论是「我发过的」，属于当前登录用户。
   *
   * 换账号时在**渲染期同步**清空，并用加载代次丢弃迟到响应 —— 否则会出现
   * 「B 的身份已经渲染、画的却还是 A 的评论」。`useEffect(() => setItems([]), [userId])`
   * 不行：effect 在 commit 之后才跑，泄漏帧照样存在（与 `pages/mylist` 同一套写法）。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  const loadEpoch = useRef(0)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    loadEpoch.current += 1
    setItems(demo ? DEMO_MY_COMMENTS : [])
    setLoading(!demo)
    setError(null)
    setCursor(null)
    setCounts(NO_COUNTS)
    setSegment('all')
  }

  /**
   * 拉一段列表（第 1 页）。取数**只由登录态与身份驱动**（不在 `useLoad` 里抢跑）：
   * 冷启动 `authStatus` 还是 `unknown` 时不该按未登录身份读一遍。
   *
   * 代次守卫：返回时若已不是最新一次（换账号 / 又一次刷新 / 已切到别的段），整批丢弃。
   * `silent` = 下拉刷新：系统已拉出原生指示器，不把列表换成骨架屏（保住阅读位置）。
   */
  const read = useCallback(async (target: CommentSegment, silent = false) => {
    const epoch = ++loadEpoch.current
    if (!silent) setLoading(true)
    setError(null)
    try {
      const response = await fetchMyComments({ kind: kindOfSegment(target) })
      if (epoch !== loadEpoch.current) return
      const nowMs = Date.now()
      setItems(response.items.map((row) => toMyCommentFromResponseItem(row, nowMs)))
      setCursor(response.nextCursor)
      setCounts((prev) => ({ ...prev, [target]: response.total }))
      setLoading(false)
    } catch (caught) {
      if (epoch !== loadEpoch.current) return
      setError(isApiError(caught) ? caught.message : '网络不太好，评论没读出来')
      setLoading(false)
    }
  }, [])

  /**
   * 两段总数探测（`limit=1` 只要 `total`）。「全部」的计数 = 留言 + 评价 ——
   * 这是契约对 `kind=all` 的 `total` 的保证，不是本页自己的算法。
   * 计数是辅助数字：探测失败就摆没有数字的胶囊，不连累列表（与 profile 计数的 `—` 同口径）。
   */
  const probeCounts = useCallback(async () => {
    const owner = userIdRef.current
    try {
      const [comments, reviews] = await Promise.all([
        fetchMyComments({ kind: 'comment', limit: 1 }),
        fetchMyComments({ kind: 'review', limit: 1 }),
      ])
      // 换号 / 退出：A 发出的探测不许落到 B 的页面上（列表那条链有 `loadEpoch`，
      // 计数这条链此前没有守卫）
      if (owner === null || userIdRef.current !== owner) return
      setCounts({
        all: comments.total + reviews.total,
        listing: comments.total,
        trade: reviews.total,
      })
    } catch {
      // 静默：列表自身失败已有错误态，这里只是数字缺失
    }
  }, [])

  useEffect(() => {
    if (demo) return
    if (authStatus !== 'authed' || userId === null) return
    void read('all')
    void probeCounts()
    // `demo` 是构建期常量（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`），运行期不变，
    // 不进依赖数组（Biome 会提示它多余）
  }, [authStatus, userId, read, probeCounts])

  /** 切段：重置到该段第 1 页。真实模式发请求（代次守卫丢弃在途的旧响应）。 */
  const pickSegment = (key: CommentSegment) => {
    if (key === segment) return
    setSegment(key)
    if (demo) return
    void read(key)
  }

  /** 触底续页：只在「有游标、没在加载、当前没有错误/首次加载」时发。 */
  const loadMore = async () => {
    if (demo || loading || error !== null || loadingMoreRef.current || cursor === null) return
    const epoch = loadEpoch.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const response = await fetchMyComments({ kind: kindOfSegment(segmentRef.current), cursor })
      if (epoch !== loadEpoch.current) return
      const nowMs = Date.now()
      setItems((prev) => [
        ...prev,
        ...response.items.map((row) => toMyCommentFromResponseItem(row, nowMs)),
      ])
      setCursor(response.nextCursor)
      setCounts((prev) => ({ ...prev, [segmentRef.current]: response.total }))
    } catch {
      // 续页失败不打断已有列表，给一句可重试的提示（再触底会自动重发）
      void Taro.showToast({ title: '加载更多没成功，再往下拉试试', icon: 'none' })
    } finally {
      // 无条件复位：切段/刷新/删除/换账号都会推进 loadEpoch 并丢弃这份迟到响应，
      // 若只在代次相同时复位，一次错位就会让本页实例的触底续页永久失效
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  useReachBottom(() => {
    void loadMore()
  })

  /**
   * 下拉刷新也走同一个登录态门禁。
   *
   * `usePullDownRefresh` 注册在 `if (authStatus !== 'authed') return ...` **之前**
   * （Taro 的 hook 不能写在 early return 之后），所以未登录那一帧里用户仍可能下拉。
   * 这时读一遍会把请求发进一个正在渲染 `AuthRequired` 的页面实例，显式拦掉 ——
   * 与 `pages/orders-buy` 用 `authedRef` 拦 `useDidShow` 同一手法（回调闭包会过期，
   * 走 ref 读当前值）。
   */
  const authedRef = useRef(false)
  authedRef.current = authStatus === 'authed'

  usePullDownRefresh(() => {
    if (demo || !authedRef.current) {
      void Taro.stopPullDownRefresh()
      return
    }
    void read(segmentRef.current, true).then(() => Taro.stopPullDownRefresh())
  })

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  const demoCounts = countBySegment(items)
  const countOf = (key: CommentSegment): number | null => (demo ? demoCounts[key] : counts[key])

  /**
   * 行上「查看商品 / 查看订单」。真实行带 `targetId`（留言 = listingId、评价 = transactionId），
   * 直接跳对应详情页；演示行没有可跳的 id，给说明 toast，不假装跳成功。
   */
  const openRow = (item: MyComment) => {
    if (item.targetId === null) {
      toast(`演示数据：这条没有${viewTargetOf(item.kind)}的 id，暂不跳转`)
      return
    }
    if (item.kind === 'TRADE') {
      void Taro.navigateTo({ url: `/pkg-trade/pages/transaction-meetup/index?id=${item.targetId}` })
      return
    }
    void Taro.navigateTo({ url: `/pkg-browse/pages/listing-detail/index?id=${item.targetId}` })
  }

  /**
   * 删除：留言走 `DELETE /comments/:id`（会级联删掉它下面的回复），评价走评价边
   * `DELETE /transactions/:id/review`。二级确认按行类型把后果说清楚；成功后**重拉**
   * 当前列表与计数 —— 不用响应的 `deleted` 本地减（含级联的他人回复，减了必漂）。
   */
  const removeRow = (item: MyComment) => {
    if (item.deleteRef === null) {
      toast('演示数据：这条删除不了')
      return
    }
    if (deletingId !== null) return
    const ref: MyCommentDeleteRef = item.deleteRef
    void Taro.showModal({
      title: '删除这条评论？',
      content:
        ref.type === 'review'
          ? '删除后这就是一条不存在的评价，对方订单里也不再显示，不可恢复。'
          : '删除后它下面的回复也会一并删除，不可恢复。',
      confirmColor: '#e5484d',
    })
      .then(async (result) => {
        if (!result.confirm) return
        setDeletingId(item.id)
        try {
          if (ref.type === 'review') await deleteMyTransactionReview(ref.transactionId)
          else await deleteMyComment(ref.commentId)
          toast('已删除')
          await read(segmentRef.current)
          void probeCounts()
        } catch (caught) {
          toast(isApiError(caught) ? caught.message : '删除没成功，请重试')
        } finally {
          setDeletingId(null)
        }
      })
      .catch(() => {})
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /** 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**，避免落地前先画一帧 */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  const rows = demo ? filterBySegment(items, segment) : items
  const empty = emptyStateOf(segment)
  const total = countOf(segment)
  const tailText =
    loadingMore || loading
      ? null
      : cursor === null || demo
        ? `已显示全部 ${total ?? rows.length} 条`
        : null

  const card = (item: MyComment) => {
    const trade = item.kind === 'TRADE'
    const chip = ratingChipOf(item.rating)
    const deleting = deletingId === item.id
    return (
      <View key={item.id} className="cmt__item">
        <View className="cmt__row">
          <View className="cmt__thumb">
            <Image
              className="cmt__thumb-img"
              src={item.coverUrl ?? blockOf(item.category)}
              mode="aspectFill"
            />
            {item.category !== null ? (
              <Text className="cmt__thumb-tx">{shortCategoryLabel(item.category)}</Text>
            ) : null}
          </View>

          <View className="cmt__main">
            <Text className="cmt__title">{item.title}</Text>
            <View className="cmt__price">
              <Text className="cmt__cur">¥</Text>
              <Text className="cmt__amt num">{formatAmount(item.priceCents)}</Text>
            </View>
          </View>

          {/* 动作竖排在右侧：查看（商品 / 订单）+ 删除。删除每行都有，没有批量入口。 */}
          <View className="cmt__acts">
            <View className="cmt__abtn" onClick={() => openRow(item)}>
              <Text>{trade ? '查看订单' : '查看商品'}</Text>
            </View>
            <View
              className={`cmt__abtn cmt__abtn--danger${deleting ? ' is-busy' : ''}`}
              onClick={() => removeRow(item)}
            >
              <Text>{deleting ? '删除中' : '删除'}</Text>
            </View>
          </View>
        </View>

        {/* 卡底信息带：品牌色竖条 + 我写的那句话（可为空）+ 元信息 */}
        <View className="cmt__foot">
          <View className="cmt__bar" />
          <View className="cmt__fmain">
            {item.text !== '' ? <Text className="cmt__ctext">{item.text}</Text> : null}
            {/*
              评价配图（#475）：签名 URL 直渲，点按进 previewImage 看大图。
              商品留言没有图片字段（恒为空数组），整块不渲染。
            */}
            {item.images.length > 0 ? (
              <View className="cmt__imgs">
                {item.images.map((url) => (
                  <Image
                    key={url}
                    className="cmt__img"
                    src={url}
                    mode="aspectFill"
                    onClick={() => void Taro.previewImage({ urls: item.images, current: url })}
                  />
                ))}
              </View>
            ) : null}
            <View className="cmt__cmeta">
              <Text className={`cmt__kind${trade ? ' cmt__kind--trade' : ''}`}>
                {kindLabel(item.kind)}
              </Text>
              {/* @对方与评分**只有交易评价有**：商品留言在契约里没有评分、也没有对方字段 */}
              {item.to ? <Text className="cmt__to num">{`@${item.to}`}</Text> : null}
              {chip ? <Text className={`cmt__rate ${chip.cls}`}>{chip.label}</Text> : null}
              <Text className="cmt__time num">{item.timeLabel}</Text>
            </View>
          </View>
        </View>
      </View>
    )
  }

  return (
    <View className="cmt">
      <View className="cmt__bg" />

      {/*
        顶栏统一（#386 批次 2）：`components/top-bar` 的 glass 变体 —— 返回钮 + 居中双色
        标题「我的|评论」，内容从玻璃底下滚过；`spacer` 占住主行高度。右侧没有页面级动作
        （删除长在每一行上）。分段进 `below` 槽与主行连成同一块玻璃（吸顶，订单两页同款）。
      */}
      <TopBar
        variant="glass"
        spacer
        back
        center={
          <View
            className="cmt__navtitle"
            style={{
              top: `${metrics.statusBarHeight}px`,
              height: `${metrics.contentHeight}px`,
            }}
          >
            <Text>我的</Text>
            {/* 稿 `.mp-title .hl{color:var(--brand)}`：尾段走品牌色 */}
            <Text className="cmt__navtitle-em">评论</Text>
          </View>
        }
        below={
          <View className="cmt__segwrap">
            <View className="cmt__seg">
              {SEGMENTS.map((seg) => {
                const on = seg.key === segment
                const n = countOf(seg.key)
                return (
                  <View
                    key={seg.key}
                    className={`cmt__seg-item${on ? ' is-on' : ''}`}
                    onClick={() => pickSegment(seg.key)}
                  >
                    <Text>{seg.label}</Text>
                    {n !== null ? <Text className="cmt__seg-n num">{n}</Text> : null}
                  </View>
                )
              })}
            </View>
          </View>
        }
      />

      {/*
        分段胶囊在两种构建里都渲染：演示构建本地现算计数，真实构建是**真的**过滤器
        （切段就是换一个 `kind` 重新请求），不再是 #196 时代「可点却无效」的死控件。
      */}
      <View className="cmt__header-gap is-demo" />

      <View className="cmt__body">
        {loading ? (
          [0, 1, 2].map((i) => (
            <View key={`sk-${i}`} className="cmt__skel">
              <View className="cmt__skel-row">
                <View className="cmt__skel-sq" />
                <View className="cmt__skel-col">
                  <View className="cmt__skel-bar" style={{ width: '72%' }} />
                  <View className="cmt__skel-bar" style={{ width: '30%' }} />
                </View>
              </View>
              <View className="cmt__skel-foot">
                <View className="cmt__skel-bar" style={{ width: '100%' }} />
              </View>
            </View>
          ))
        ) : error !== null ? (
          /*
            失败态**不能**用空态冒充：空是「你真的没有发过」，失败是「这次没读到」——
            混在一起用户会以为自己的评论丢了（与收藏页同一口径）。
          */
          <EmptyState
            title="评论没读出来"
            text={error}
            icon={ICONS.box}
            actionText="重试"
            onAction={() => void read(segment)}
          />
        ) : (
          <>
            {demo ? (
              <View className="cmt__demo">
                <Image className="cmt__demo-ic" src={ICONS.info} mode="aspectFit" />
                <Text className="cmt__demo-tx">
                  演示数据 · 下列内容来自本地演示库，与你的账号无关
                </Text>
              </View>
            ) : null}

            {rows.length === 0 ? (
              <EmptyState
                title={empty.title}
                text={empty.text}
                icon={ICONS.comment}
                actionText={empty.action}
                onAction={() => {
                  // 「全部」段的空态是「去逛逛」；具体段的空态按钮切回「全部」段
                  if (segment === 'all') {
                    void Taro.switchTab({ url: '/pages/home/index' })
                    return
                  }
                  pickSegment('all')
                }}
              />
            ) : (
              <>
                <View className="cmt__list">{rows.map(card)}</View>
                {tailText !== null ? (
                  <View className="cmt__tail">
                    <View className="cmt__tail-line" />
                    <Text className="cmt__tail-tx num">{tailText}</Text>
                    <View className="cmt__tail-line" />
                  </View>
                ) : null}
              </>
            )}
          </>
        )}
      </View>

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
