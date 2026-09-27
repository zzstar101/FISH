import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { loadMyComments } from '@/features/comments/load'
import {
  type CommentSegment,
  countBySegment,
  emptyStateOf,
  filterBySegment,
  kindLabel,
  type MyComment,
  NO_SOURCE_COPY,
  SEGMENTS,
  shortCategoryLabel,
  starSlots,
  viewTargetOf,
} from '@/features/comments/mine'
import { formatAmount } from '@/lib/money'
import { LISTING_BLOCKS } from '@/mock/blocks'
import './index.scss'

/**
 * 「我的评论」（`小程序1版comments.html`）。**整页没有任何可用端点**，本轮只做页面本身。
 *
 * ## 为什么是空态而不是假列表
 *
 * 「我发出去的话」在仓库里有两个来源，**两个都没有「我发过的」读路径**（完整证据见
 * `@/features/comments/mine` 的文件头）：商品留言只能按商品一条条读
 * （`CommentListQuerySchema` 没有 author 过滤），交易评价连事件本身都不存在。
 * 所以真实构建下这一页是**空态 + 如实说明缺的是哪一段能力**（`NO_SOURCE_COPY`），
 * 不是错误态、更不是编出来的列表 —— 也**不做**「遍历我的商品再逐条拉留言按作者过滤」
 * 那种 N+1 拼装：它既慢又漏掉我在别人商品下留的言，比空态更误导。
 *
 * ## 演示构建（`TARO_APP_MOCK=1`）
 *
 * 照稿摆 8 条演示数据（4 条商品留言 + 4 条交易评价），与稿的数据量一致；
 * 但**界面上必须能看出是演示数据**：分段栏下方有一条「演示数据」说明带。
 * 行上的动作也据此给说明 toast，而不是跳到必然 404 的详情页（演示 id 在库里不存在）。
 *
 * ⚠️ 这 8 条**不与「我的」页任何数字对齐**：`demoProfile()` 里没有评论 / 评价计数，
 * 「我的」页的「评价」格也不带 `count`（不出红点）。别把它当成跨页一致性要求。
 *
 * ## 三段互斥 → 才给计数
 *
 * 全部 = 商品留言 ∪ 交易评价，三个数能互相对上，所以计数摆在胶囊上（与我的发布同一判据）。
 * **真实构建整条分段栏都不渲染**：没有数据源时「0」会把「系统不知道」说成「你没有评论」
 * （与「我的」页数字栏的 `—` 同一口径），而且三个分段点下去屏幕一字不变 —— 那是死控件。
 *
 * ## 删除长在每一行上，没有「管理」批量入口
 *
 * 评论是**逐条**的东西：要删的往往是某一条说错的话，批量选择反而要点两下。
 * 删除没有端点，点击给「待接入」说明，**不做本地假删除**（那会与真实数据不一致）。
 */

/** 缩略图色块：分类基色取自 mock 的演示色块（由设计令牌派生，不是新增色值） */
function blockOf(category: MyComment['category']): string {
  const set = LISTING_BLOCKS[category]
  return set?.[0] ?? (LISTING_BLOCKS.OTHER as [string, string, string])[0]
}

export default function MyComments() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [items, setItems] = useState<MyComment[]>([])
  const [demo, setDemo] = useState(false)
  const [loading, setLoading] = useState(true)
  const [segment, setSegment] = useState<CommentSegment>('all')
  const [showTop, setShowTop] = useState(false)

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
    setItems([])
    setDemo(false)
    setLoading(true)
    setSegment('all')
  }

  /**
   * 取数**只由登录态与身份驱动**（不在 `useLoad` 里抢跑）：冷启动 `authStatus` 还是
   * `unknown` 时不该按未登录身份读一遍，`unknown → authed` 自然触发首次加载。
   *
   * `silent` = 下拉刷新：系统已经拉出原生指示器，不把列表换成骨架屏（否则用户丢掉阅读位置）。
   */
  const read = useCallback(async (silent = false) => {
    // 本次读取的代次：返回时若已不是最新一次，整批结果丢弃（换账号 / 又一次刷新）
    const epoch = ++loadEpoch.current
    if (!silent) setLoading(true)
    const result = await loadMyComments()
    if (epoch !== loadEpoch.current) return
    setItems(result.items)
    setDemo(result.demo)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void read()
  }, [authStatus, userId, read])

  /**
   * 下拉刷新也走同一个登录态门禁。
   *
   * `usePullDownRefresh` 注册在 `if (authStatus !== 'authed') return ...` **之前**
   * （Taro 的 hook 不能写在 early return 之后），所以未登录那一帧里用户仍可能下拉。
   * 这时读一遍会把结果写进一个正在渲染 `AuthRequired` 的页面实例。刷新本身是幂等的、
   * 值也一样，但「守卫在跳转、页面却在取数」是不该有的状态，所以显式拦掉 ——
   * 与 `pages/orders-buy` 用 `authedRef` 拦 `useDidShow` 同一手法（回调闭包会过期，
   * 走 ref 读当前值）。
   */
  const authedRef = useRef(false)
  authedRef.current = authStatus === 'authed'

  usePullDownRefresh(() => {
    if (!authedRef.current) {
      void Taro.stopPullDownRefresh()
      return
    }
    void read(true).then(() => Taro.stopPullDownRefresh())
  })

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  const counts = countBySegment(items)
  const rows = filterBySegment(items, segment)

  /**
   * 行上「查看商品 / 查看订单」。
   *
   * **跳不了的真实原因不是「演示数据不存在」**：`DEMO_MY_COMMENTS` 里有几条确实指向
   * fixture 里真实存在的商品与成交（C05 → t-104、C06 → t-106、C01 → 索尼那件）。
   * 真正的原因是**行模型里没有可跳转的 id** —— `MyComment` 只有评论自己的 `id`，
   * 没有 `listingId` / `transactionId`（契约也没有「我发过的评论」读模型可参照，
   * 见 `@/features/comments/mine` 的文件头）。拿不到目标 id 就没法跳，所以给说明 toast，
   * 不假装跳成功、也不跳到一个猜出来的页面。
   *
   * ⚠️ 将来接线时**先给 `MyComment` 补上这两个 id**，再让这里真跳；不要因为看错了
   * 上面那句老注释（曾写成「演示数据在库里不存在」）而以为只要换成真实数据就能跳。
   */
  const openRow = (item: MyComment) => {
    if (!demo) {
      // 真实构建下这一行还不存在（一条评论都读不到），留一句兜底，避免将来接线时静默无响应
      toast(`${viewTargetOf(item.kind)}待接入`)
      return
    }
    toast(`演示数据：这条没有${viewTargetOf(item.kind)}的 id，暂不跳转`)
  }

  /** 删除：没有端点，如实说明，不做本地假删除（与真实数据不一致） */
  const removeRow = () => toast('删除评论功能待接入')

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /** 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**，避免落地前先画一帧 */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  const empty = demo ? emptyStateOf(segment) : NO_SOURCE_COPY

  const card = (item: MyComment) => {
    const trade = item.kind === 'TRADE'
    const stars = starSlots(item.rating)
    return (
      <View key={item.id} className="cmt__item">
        <View className="cmt__row">
          <View className="cmt__thumb">
            <Image className="cmt__thumb-img" src={blockOf(item.category)} mode="aspectFill" />
            <Text className="cmt__thumb-tx">{shortCategoryLabel(item.category)}</Text>
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
            <View className="cmt__abtn cmt__abtn--danger" onClick={removeRow}>
              <Text>删除</Text>
            </View>
          </View>
        </View>

        {/* 卡底信息带：本页与收藏页唯一的差异处（品牌色竖条 + 我写的那句话 + 元信息） */}
        <View className="cmt__foot">
          <View className="cmt__bar" />
          <View className="cmt__fmain">
            <Text className="cmt__ctext">{item.text}</Text>
            <View className="cmt__cmeta">
              <Text className={`cmt__kind${trade ? ' cmt__kind--trade' : ''}`}>
                {kindLabel(item.kind)}
              </Text>
              {/* @对方与星级**只有交易评价有**：商品留言在契约里没有评分、也没有对方字段 */}
              {item.to ? <Text className="cmt__to num">{`@${item.to}`}</Text> : null}
              {stars ? (
                <View className="cmt__stars">
                  {stars.map((slot) => (
                    <Image
                      key={slot.key}
                      className="cmt__star"
                      src={slot.filled ? ICONS.starAccent : ICONS.starLine}
                      mode="aspectFit"
                    />
                  ))}
                </View>
              ) : null}
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

      {/* 导航条右侧没有页面级动作（删除长在每一行上），标题居中 */}
      <NavBar title="我的评论" titleAlign="center" />

      {/*
        分段胶囊**只在演示构建里有**（`demo`）。

        真实构建下这一页只有一句缺口说明（`NO_SOURCE_COPY`，与 `segment` 无关）、
        计数也不渲染（见文件头），所以三个胶囊点下去只会换选中态、屏幕上一字不变 ——
        那是一个「可点却完全无效」的控件，等于在暗示这里能按类型筛。

        ⚠️ 这是**本页自己的**判据，不是「跟同族页面一样」：同一模板下的收藏页在同样
        没有数据源的情况下是**常驻渲染**分段的（`pages/favorites` 的 `.fav__seg` 没有
        任何门禁）。两页取舍不同，因为那边的分段切完至少会换一套空态文案、这边不会。
        别拿这句当先例引用。

        `.cmt__head` 本身**始终渲染**：它的 `padding-top: 168px` 是给漂浮导航条留的
        顶栏高度，拿掉整块会让空态钻到返回钮与标题下面。

        ⚠️ 将来聚合端点落地时**不要照抄 `demo` 这个条件**：那时 `demo` 是 `false`
        而页面有真数据，分段的显隐该改判「有没有可筛的东西」（即真实结果非空）。
      */}
      <View className="cmt__head">
        {demo ? (
          <View className="cmt__seg">
            {SEGMENTS.map((seg) => {
              const on = seg.key === segment
              return (
                <View
                  key={seg.key}
                  className={`cmt__seg-item${on ? ' is-on' : ''}`}
                  onClick={() => setSegment(seg.key)}
                >
                  <Text>{seg.label}</Text>
                  <Text className="cmt__seg-n num">{counts[seg.key]}</Text>
                </View>
              )
            })}
          </View>
        ) : null}
      </View>

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
        ) : (
          <>
            {/*
              演示数据说明带：这一页没有后端，摆的是 fixture —— 界面上必须能认出来。
              真实构建下不会走到这里（那时 `items` 为空、`demo` 为 false）。
            */}
            {demo ? (
              <View className="cmt__demo">
                <Image className="cmt__demo-ic" src={ICONS.info} mode="aspectFit" />
                <Text className="cmt__demo-tx">
                  演示数据 · 「我发过的评论」还没有后端接口，下列内容仅供演示，与你的账号无关
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
                  // 真实构建只有一个空态（读不到任何评论），按钮是「去逛逛」—— 它就该去逛逛；
                  // 演示构建的空态是分段的，「看全部评论」才切回「全部」段。
                  if (!demo || segment === 'all') {
                    void Taro.switchTab({ url: '/pages/home/index' })
                    return
                  }
                  setSegment('all')
                }}
              />
            ) : (
              <>
                <View className="cmt__list">{rows.map(card)}</View>
                <View className="cmt__tail">
                  <View className="cmt__tail-line" />
                  <Text className="cmt__tail-tx num">{`已显示全部 ${rows.length} 条`}</Text>
                  <View className="cmt__tail-line" />
                </View>
              </>
            )}
          </>
        )}
      </View>

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
