import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import TopBar from '@/components/top-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { fetchMyFavorites, setFavorite } from '@/features/favorites/api'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { type Cancellable, cancellable } from '@/lib/cancellable'
import { formatAmount } from '@/lib/money'
import { isApiError } from '@/lib/request'
import {
  emptyCopy,
  FAVORITE_SEGMENTS,
  type FavoriteItem,
  type FavoriteSegment,
  itemsOf,
  loadDemoFavorites,
  toFavoriteItems,
} from './list'
import './index.scss'

/**
 * 我的收藏（设计稿 `小程序1版favorites.html`，模板 A 的调用方之一）。
 *
 * ## 数据源（端点随 #394 上线，本页已接真接口）
 *
 * `GET /me/favorites` 是唯一出口（`@/features/favorites/api` 收口契约与解析）。
 * 于是本页有**四种**诚实形态，没有一种需要编造：
 *
 * 1. **骨架屏**：真有一份请求在飞；
 * 2. **列表**：接口回来的行，经 `./list.ts` 的 `toFavoriteItems` 适配成排版行；
 * 3. **空态**：接口成功但这一段没有行 —— 如实说「还没有收藏的宝贝」（`emptyCopy`）；
 * 4. **失败态**：请求失败。**不再用空态冒充失败** —— 那会让用户以为自己的收藏丢了。
 *
 * **演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，两个开关都要）才读 fixture：
 * 摆 8 件（6 有效 + 2 失效）设计稿示例数据，条数与 `features/fetchers.ts` 的
 * `demoProfile()`（收藏 8）对齐，否则演示时会出现「我的页数字栏 8、点进来 6 件」这种自相矛盾。
 *
 * ## 分页
 *
 * 契约一页最多 50 条、默认 20，`nextCursor !== null` 表示还有下一页，`total` 是**全量**计数。
 * 本页没有「加载更多」的交互位，所以 `loadFavorites()` 把页翻完（上限见 `MAX_PAGES`），
 * 用 `items.length >= total` 判断是否真的取全 —— 没取全时列表末尾**不写「已显示全部」**，
 * 免得在一页装不下的收藏夹上说假话。
 *
 * ## 写操作
 *
 * - **批量管理是纯前端 UI 状态**（`managing` / `selected`）：勾选、全选、进出管理态
 *   都不代表任何一次写入，所以可以照稿做；
 * - **「取消收藏」是真写**：`DELETE /listings/:id/favorite`（幂等），成功后**就地摘掉那些行**
 *   并按服务端结果把 `total` 减掉 —— 不靠重拉整页，也不做「本地删了刷新又回来」的假动作；
 *   失败的 id 原样留在选中集合里，用户能看见哪几条没成功；
 * - 「聊一聊」给「待接入」说明，「立即购买」与点行按稿进商品详情页 ——
 *   演示数据的 id 在库里不存在，跳过去必然 404，所以演示行给说明 toast，
 *   **不跳、也不假装跳成功**（判据是行上的 `demo` 标记，见 `./list.ts`）。
 *
 * ## 稿里刻意没有的东西（别加回来）
 *
 * - **「已降价 ¥N」角标**：Owner 2026-09-22 决策③b，不做降价提醒，稿里连
 *   `priceDropCents` 字段一起删了；
 * - **分段胶囊上的计数**：只有两段，件数在列表末尾的「已显示全部 N 件」里已说过；
 * - **失效行的动作**：留着可点的按钮等于承诺一个做不到的动作（决策④）。
 *
 * Owner 2026-09-23 又拍了五条版式，**它们覆盖了稿与方案里原来的写法**：
 * **统计行（共 N 件 · 有效 x · 失效 y）整行去掉**；**标题改两段式**（「我的」墨色 +
 * 「收藏」品牌色，与消息页同一套 `TopBar` 写法）；**「管理」要真的能进管理态**（稿里
 * 它只弹一句「批量管理待接入」）；**聊一聊 / 立即购买位置与配色互换**（聊一聊为主）；
 * **演示数据那句小注释行去掉**（代价是屏幕上不再有「这是演示数据」的标记 ——
 * 演示行点下去仍会给说明 toast，见上）。
 */

/**
 * 演示构建：**两个开关都要**（与「我的」页的回退口径一致）。
 * 只认 `MOCK_FALLBACK_ENABLED` 不行 —— `dev:weapp` 的日常开发也满足它，
 * 那会把真实构建该有的缺口空态顶掉。
 */
const DEMO_MODE = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

/** 一次取数的结果：适配好的行 + 服务端的全量计数（用来判断有没有取全） */
type FavoritesLoad = {
  items: FavoriteItem[]
  /** 服务端 `total`：**全量**收藏数，不是这一页 / 这一次翻页的长度 */
  total: number
}

/**
 * 翻页上限（10 × 20 = 200 件）。
 *
 * 本页没有「加载更多」的交互位，所以真接口要自己把页翻完；但**不能无限翻** ——
 * `nextCursor` 一旦因为服务端 bug 原地打转就是死循环。到顶时页面会看到
 * `items.length < total`，列表末尾因此不写「已显示全部」（见文件头的「分页」）。
 */
const MAX_PAGES = 10

/**
 * 读取失败时给用户的那句话。
 *
 * 优先用服务端文案（`ApiError.message` 本来就是给人看的一句话），
 * 拿不到才退回通用文案 —— 不把「请求超时」这类底层异常原文贴到界面上。
 */
function failureText(caught: unknown): string {
  return isApiError(caught) ? caught.message : '网络不太好，收藏没读出来'
}

/**
 * 本页的「取数」。
 *
 * 真实构建调 `GET /me/favorites` 并翻完页；演示构建读 fixture（见 `./list.ts`）。
 * **失败不在这里吞**：直接抛给 `startLoad`，由它转成页面的失败态 ——
 * 用空态冒充失败会让用户以为自己的收藏丢了。
 */
async function loadFavorites(): Promise<FavoritesLoad> {
  if (DEMO_MODE) {
    const items = await loadDemoFavorites()
    return { items, total: items.length }
  }
  // 一屏的「收藏时间」必须共用同一把尺子（见 `toFavoriteItems` 的 `nowMs` 约定）
  const nowMs = Date.now()
  const items: FavoriteItem[] = []
  let total = 0
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchMyFavorites(cursor)
    items.push(...toFavoriteItems(response.items, nowMs))
    total = response.total
    if (response.nextCursor === null) break
    cursor = response.nextCursor
  }
  return { items, total }
}

export default function Favorites() {
  const authStatus = useAuthGuard()
  const auth = useAuth()
  const userId = auth.user?.id ?? null

  const [items, setItems] = useState<FavoriteItem[]>([])
  /** 服务端 `total`：判断列表有没有取全（决定末尾写不写「已显示全部」） */
  const [total, setTotal] = useState(0)
  /**
   * 读取失败的那句话。**与空态分开**：空列表是「你真的没有收藏」，
   * 读失败是「这次没读到」—— 用空态冒充失败会让用户以为自己的收藏丢了。
   */
  const [error, setError] = useState<string | null>(null)
  /** 两种构建初次进入都必有一次在途请求 → 初值就是 loading，不闪一帧空态 */
  const [loading, setLoading] = useState(true)
  const [segment, setSegment] = useState<FavoriteSegment>('sale')
  const [showTop, setShowTop] = useState(false)

  /** 批量管理态：进出、勾选都只是本地 UI 状态，不代表任何一次写入（见文件头） */
  const [managing, setManaging] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  /** 「取消收藏」在途：挡住连点，避免同一批被写两遍 */
  const [removing, setRemoving] = useState(false)

  /** 最近一次在飞的读取：换账号 / 卸载时取消，迟到的结果不再写状态（`@/lib/cancellable`） */
  const inFlight = useRef<Cancellable<FavoritesLoad> | null>(null)
  /**
   * 本页数据属于**哪个账号**。渲染期就能拿到上一帧的 `userId`，所以在**同一帧内**
   * 把账号作用域状态清干净，不会出现「B 的身份已经渲染出来了，画的却还是 A 的数据」。
   * 换成 `useEffect(() => setItems([]), [userId])` 不行：effect 在 commit 之后才跑，
   * 泄漏帧照样存在。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)

  if (prevUserId !== userId) {
    setPrevUserId(userId)
    inFlight.current?.cancel()
    setItems([])
    setTotal(0)
    setError(null)
    setLoading(true)
    setSegment('sale')
    // 选中集合是按 id 记的，换账号后必须一并清掉，否则会「勾着上一个人的宝贝」
    setManaging(false)
    setSelected([])
    setRemoving(false)
  }

  /**
   * 起一次读取（并作废上一次在飞的），返回**被接受**的那份结果（取消时为 `null`）。
   * 初次加载与下拉刷新共用它，避免两套竞态口径。
   *
   * 用 `useCallback` 而不是裸函数：它要进 effect 的依赖（否则 lint 的
   * `useExhaustiveDependencies` 会拦；那条规则不是形式主义 —— 漏依赖正是
   * 「换账号后页面还画着上一个账号」这类 bug 的入口）。
   * 依赖里没有会变的东西，所以身份不变时它不会让 effect 多跑。
   */
  const startLoad = useCallback(async (): Promise<FavoritesLoad | null> => {
    inFlight.current?.cancel()
    const current = cancellable(loadFavorites, () => true)
    inFlight.current = current
    setError(null)
    let next: FavoritesLoad | null
    try {
      next = await current.promise
    } catch (caught) {
      // 已经被后一次读取顶掉 / 已卸载之后才失败的：那次失败不属于这一屏，不写状态
      if (current.isCancelled()) return null
      setLoading(false)
      setItems([])
      setTotal(0)
      setError(failureText(caught))
      return null
    }
    // `null` = 已被取消（换账号 / 卸载 / 被后一次读取顶掉）：整份结果丢弃，不写状态
    if (next === null) return null
    setItems(next.items)
    setTotal(next.total)
    setLoading(false)
    // 列表换了一茬，旧的勾选不再对得上任何一行（刷新后还留着勾是「选了不存在的东西」）
    setSelected([])
    return next
  }, [])

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    setLoading(true)
    void startLoad()
    // 取消的是**最新**那次：卸载时可能还有一次下拉刷新在飞
    return () => {
      inFlight.current?.cancel()
    }
  }, [authStatus, userId, startLoad])

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  usePullDownRefresh(() => {
    if (authStatus !== 'authed' || userId === null) {
      void Taro.stopPullDownRefresh()
      return
    }
    void startLoad().then((next) => {
      void Taro.stopPullDownRefresh()
      // 只有真取到了才报数字；失败时 `startLoad` 已经把失败态写在页面上
      if (next) toast(`已刷新 · ${next.items.length} 件收藏`)
    })
  })

  const toast = (text: string) => {
    void Taro.showToast({ title: text, icon: 'none' })
  }

  /** 「管理」⇄「退出管理」：只是切换本页的勾选态，不动任何数据 */
  const toggleManaging = () => {
    // 退出管理时清空勾选：再进来时不该看见上一轮的选中还留着。
    // **放在 updater 外面**：updater 必须是纯函数（React 会重放它），副作用写进去
    // 在 StrictMode 下会跑两遍，而且「读上一帧的 managing」在 updater 里并不可靠。
    if (managing) setSelected([])
    setManaging(!managing)
  }

  const togglePick = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((one) => one !== id) : [...prev, id]))
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /**
   * 点行 / 「立即购买」：真实行进商品详情（真正的「我想要」长在那里）。
   * 失效行不进详情（它已被下架或卖掉，详情页看到的却是「还能买」，与这一行自相矛盾）；
   * 演示行的 id 不在库里，跳过去必然 404 —— 给说明，**不跳、也不假装跳成功**。
   */
  const openItem = (item: FavoriteItem) => {
    if (item.segment === 'gone') {
      toast(`这件宝贝${item.goneReason}了`)
      return
    }
    if (item.demo) {
      toast('演示数据：这件商品不在库里，进不了详情页')
      return
    }
    void Taro.navigateTo({ url: `/pkg-browse/pages/listing-detail/index?id=${item.id}` })
  }

  /**
   * 缩略图 / 标题 / 两个动作钮上的点击在管理态里都走勾选（稿里勾选与进详情是互斥的
   * 两个动作）。
   *
   * **不是整张卡**：卡底信息带（`.fav__foot`）与各块的留白没有接事件，管理态点在那里
   * 不会有反应 —— 勾选热区只有勾选圈、缩略图、标题、两个动作钮这几块。
   */
  const onRowTap = (item: FavoriteItem) => {
    if (managing) {
      togglePick(item.id)
      return
    }
    openItem(item)
  }

  /**
   * 卡上的两个动作钮在管理态里同样走勾选，不各干各的。
   *
   * 否则底栏开着「全选 / 取消收藏」，点「立即购买」却把人带去了商品详情页 ——
   * 勾选期的一次误触就离开本页，而卡片右移的版式本来就是在说「现在在挑东西」。
   */
  const act = (item: FavoriteItem, run: (one: FavoriteItem) => void) => {
    if (managing) {
      togglePick(item.id)
      return
    }
    run(item)
  }

  /** 「聊一聊」：后端有 `POST /conversations`，但小程序侧未接（商品详情页同为 toast） */
  const chat = () => toast('聊天待接入')

  const shown = itemsOf(items, segment)
  const empty = emptyCopy(segment)

  /** 全选的作用域是**当前这一段**：失效宝贝在另一段，两段的勾选互不干扰 */
  const allPicked = shown.length > 0 && shown.every((item) => selected.includes(item.id))

  const toggleAll = () => {
    setSelected(allPicked ? [] : shown.map((item) => item.id))
  }

  /**
   * 「取消收藏」：**真写**（`DELETE /listings/:id/favorite`，幂等，见 `@/features/favorites/api`）。
   *
   * 契约只有单品路径，没有批量端点，所以逐条写。**按服务端结果摘行**：成功的那几条从
   * `items` 里去掉并把 `total` 减掉，失败的原样留着、也继续留在选中集合里 ——
   * 用户能看见哪几条没成功，而不是本地先删再回滚（那会让人以为取消了，刷新一次又回来）。
   *
   * 演示行的 id（`F01` 这种）不在库里，写过去必然 404 —— 一并按「不假装」处理：
   * 只给一句说明，不把它算进成功数（判据是行上的 `demo` 标记，见 `./list.ts`）。
   */
  const removePicked = async () => {
    if (selected.length === 0) {
      toast('还没有选中宝贝')
      return
    }
    if (removing) return
    const realIds = items
      .filter((item) => selected.includes(item.id) && !item.demo)
      .map((item) => item.id)
    if (realIds.length === 0) {
      toast('演示数据：这些宝贝不在库里，取消不了')
      return
    }

    setRemoving(true)
    const failed: string[] = []
    let removed = 0
    for (const id of realIds) {
      try {
        await setFavorite(id, false)
        removed += 1
      } catch {
        failed.push(id)
      }
    }
    setRemoving(false)

    if (removed > 0) {
      const keep = new Set(failed)
      setItems((prev) => prev.filter((item) => keep.has(item.id)))
      setTotal((prev) => Math.max(0, prev - removed))
    }
    setSelected(failed)

    if (failed.length === 0) {
      toast(removed > 1 ? `已取消 ${removed} 件收藏` : '已取消收藏')
      return
    }
    toast(
      removed === 0 ? '取消收藏没成功，请重试' : `${removed} 件已取消，${failed.length} 件没成功`,
    )
  }

  const onEmptyAction = () => {
    if (empty.action === 'browse') {
      // 首页是 Tab 页，真跳（不是 toast）
      void Taro.switchTab({ url: '/pages/home/index' })
      return
    }
    setSegment('sale')
  }

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染** ——
   * 演示数据是内存里就有的，不拦的话跳转落地前会先画一帧收藏列表。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  return (
    <View className={`fav${managing ? ' is-managing' : ''}`}>
      {/* 顶部冰蓝渐变圆角背景：玻璃顶栏压在它上面，滚过去的内容从玻璃底下透出 */}
      <View className="fav__bg" />

      {/*
        顶栏用 `components/top-bar`（**一级页的固定玻璃栏**，不是二级页的漂浮 `nav-bar`）：
        Owner 2026-09-23 要求标题照消息页做**两段式**（「我的」墨色 + 「收藏」品牌色），
        而那正是 `TopBar` 的 `title` / `titleEm` 两个 prop 的用法；`nav-bar` 的标题是
        单个字符串，给不了两色。

        它同时替页面做掉三件原本手写的事：`fixed`、与原生胶囊的避让（`paddingRight`
        由运行时反推，所以这里**不再**需要 `readNavMetrics` 与「管理」钮的手工让位），
        以及主行的等高占位块（`spacer`）。副行（分段胶囊）进 `below`，与主行连成
        同一块玻璃 —— 与消息页的筛选行同一形态，副行占位由下面的 `.fav__gap` 补。
      */}
      <TopBar
        back
        variant="glass"
        spacer
        title="我的"
        titleEm="收藏"
        /**
         * 空的中槽是**必需**的：`.topbar__row` 是普通 flex、没有 `justify-content`，
         * `actions` 槽只保证「排在标题之后、不压到原生胶囊」，不负责贴右 ——
         * 少这一块的时候实测动作钮右边还空着 ~110px 玻璃，「管理」看着像标题的后缀。
         * `.topbar__center` 本身是 `flex: 1 1 auto`，所以由它吃掉这段余量，
         * 动作才落到右侧边界（该边界就是组件按运行时胶囊位置下发的 `padding-right`）。
         */
        center={<View className="fav__rowfill" />}
        actions={
          <View className="fav__manage" onClick={toggleManaging}>
            <Text>{managing ? '退出管理' : '管理'}</Text>
          </View>
        }
        below={
          <View className="fav__segwrap">
            {/* 两段分段胶囊；**不摆计数**（见文件头决策③） */}
            <View className="fav__seg">
              {FAVORITE_SEGMENTS.map((seg) => (
                <View
                  key={seg.key}
                  className={`fav__seg-item${seg.key === segment ? ' is-on' : ''}`}
                  onClick={() => {
                    setSegment(seg.key)
                    // 换段时清勾选：两段的勾选互不干扰，跨段留着会「勾着看不见的行」
                    setSelected([])
                  }}
                >
                  <Text>{seg.label}</Text>
                </View>
              ))}
            </View>
          </View>
        }
      />

      {/* 副行（分段胶囊）的占位：`TopBar` 的 `spacer` 只含主行，副行得自己补 */}
      <View className="fav__gap" />

      <View className="fav__body">
        {loading ? (
          <View className="fav__skeleton">
            {[0, 1, 2].map((i) => (
              <View key={`sk-${i}`} className="fav__skel">
                <View className="fav__skel-row">
                  <View className="fav__skel-sq" />
                  <View className="fav__skel-col">
                    <View className="fav__skel-bar" style={{ width: '74%' }} />
                    <View className="fav__skel-bar" style={{ width: '34%' }} />
                  </View>
                </View>
                <View className="fav__skel-foot">
                  <View className="fav__skel-pill" />
                  <View className="fav__skel-pill" style={{ width: '96px' }} />
                </View>
              </View>
            ))}
            <View className="fav__skel-hint">
              <View className="fav__spin" />
              <Text className="fav__skel-hint-tx">正在读取收藏…</Text>
            </View>
          </View>
        ) : error !== null ? (
          /*
            失败态**不能**用空态冒充：空列表是「你真的没有收藏」，读失败是「这次没读到」——
            混在一起，用户会以为自己的收藏丢了。所以这一支单独渲染，并给一个重试出口。
          */
          <EmptyState
            title="收藏没读出来"
            text={error}
            icon={ICONS.box}
            actionText="重试"
            onAction={() => {
              setLoading(true)
              void startLoad()
            }}
          />
        ) : shown.length === 0 ? (
          <EmptyState
            title={empty.title}
            text={empty.text}
            icon={empty.icon === 'heart' ? ICONS.heartMuted : ICONS.box}
            actionText={empty.actionLabel}
            onAction={onEmptyAction}
          />
        ) : (
          <>
            <View className="fav__list">
              {shown.map((item) => {
                const gone = item.segment === 'gone'
                const picked = selected.includes(item.id)
                return (
                  <View
                    key={item.id}
                    className={`fav__item${gone ? ' is-gone' : ''}${managing ? ' is-managing' : ''}${picked ? ' is-picked' : ''}`}
                  >
                    <View className="fav__row">
                      {/*
                        勾选圈：**常驻渲染**、靠宽度 0↔40 收起展开。整块条件渲染的话
                        「卡片全部右移」是一帧跳变，没有滑动过程。
                      */}
                      <View className="fav__pick" onClick={() => togglePick(item.id)}>
                        <View className={`fav__round${picked ? ' is-on' : ''}`}>
                          {picked ? (
                            <Image
                              className="fav__round-ic"
                              src={ICONS.checkWhite}
                              mode="aspectFit"
                            />
                          ) : null}
                        </View>
                      </View>

                      <View className="fav__thumb" onClick={() => onRowTap(item)}>
                        <Image className="fav__thumb-img" src={item.coverUrl} mode="aspectFill" />
                        <Text className="fav__thumb-cat">{item.categoryText}</Text>
                        {gone ? <Text className="fav__thumb-mk">{item.goneReason}</Text> : null}
                      </View>

                      <View className="fav__main">
                        <Text className="fav__rtitle" onClick={() => onRowTap(item)}>
                          {item.title}
                        </Text>
                        <View className="fav__rprice">
                          <Text className="fav__cur">¥</Text>
                          <Text className="fav__amt num">{formatAmount(item.priceCents)}</Text>
                        </View>
                        {/* 稿决策③b：「已降价 ¥N」角标不做（不做降价提醒），这里没有它 */}
                      </View>

                      {/*
                        失效行不给动作（决策④）：留着可点的按钮等于承诺一个做不到的动作。
                        管理态里两个钮也让位给勾选 —— 见 `onRowTap` 上方的说明。
                      */}
                      {gone ? null : (
                        <View className="fav__acts">
                          <View className="fav__abtn" onClick={() => act(item, openItem)}>
                            <Text>立即购买</Text>
                          </View>
                          <View
                            className="fav__abtn fav__abtn--primary"
                            onClick={() => act(item, chat)}
                          >
                            <Text>聊一聊</Text>
                          </View>
                        </View>
                      )}
                    </View>

                    <View className="fav__foot">
                      <View className="fav__seller">
                        <Image className="fav__av" src={item.avatarUrl} mode="aspectFill" />
                        <Text className="fav__nm">{item.seller}</Text>
                        {item.verified ? (
                          <Image
                            className="fav__tick"
                            src={ICONS.verifiedAccent}
                            mode="aspectFit"
                          />
                        ) : null}
                      </View>
                      <View className="fav__fmeta">
                        {/* 契约没有「想要」计数 → 适配层给 null 时整块不画，不编成 0
                            （与 `components/product-card`、`pages/listing-detail` 同一条口径） */}
                        {item.wants === null ? null : (
                          <Text className="num">{item.wants} 人想要</Text>
                        )}
                        <Text className="num">{item.savedLabel}</Text>
                      </View>
                    </View>
                  </View>
                )
              })}
            </View>

            {/*
              「全部 N 件」里的 N 是**这一段**的件数。
              `items.length < total` 说明翻页到了上限还没取全，此时**不能**写「全部」——
              在一个装不下的收藏夹上说「已显示全部」就是假话。
            */}
            <View className="fav__end">
              <View className="fav__end-line" />
              <Text className="fav__end-tx num">
                {items.length >= total
                  ? `已显示全部 ${shown.length} 件`
                  : `已显示前 ${shown.length} 件（共 ${total} 件）`}
              </Text>
              <View className="fav__end-line" />
            </View>
          </>
        )}
      </View>

      {/*
        批量管理底栏：全选 + 取消收藏。只在管理态出现，且**只在真的有行时**出现 ——
        空列表上摆一条「取消收藏」是给一个没有对象的动作。
      */}
      {managing && shown.length > 0 ? (
        <View className="fav__sheet">
          <View className="fav__all" onClick={toggleAll}>
            <View className={`fav__round${allPicked ? ' is-on' : ''}`}>
              {allPicked ? (
                <Image className="fav__round-ic" src={ICONS.checkWhite} mode="aspectFit" />
              ) : null}
            </View>
            <Text className="fav__all-tx">全选</Text>
          </View>

          <View className="fav__remove" onClick={() => void removePicked()}>
            <Text>{removing ? '取消中…' : '取消收藏'}</Text>
          </View>
        </View>
      ) : null}

      <BackTop show={showTop && !managing} onTop={backToTop} />
    </View>
  )
}
