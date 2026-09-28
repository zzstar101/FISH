import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, {
  useDidShow,
  useLoad,
  usePageScroll,
  usePullDownRefresh,
  useReady,
  useUnload,
} from '@tarojs/taro'
import { useMemo, useRef, useState } from 'react'
import brandLogo from '@/assets/brand/logo.png'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import LoadError from '@/components/load-error'
import ProductCard from '@/components/product-card'
import TopBar from '@/components/top-bar'
import { loadCategoryListings, loadHomeFeed } from '@/features/fetchers'
import type { FeedAttribution } from '@/features/recommendation/attribution'
import { hideListing, readHiddenListingIds } from '@/features/recommendation/hidden'
import { flushRecommendationQueue } from '@/features/recommendation/queue'
import { trackRecommendationEvent } from '@/features/recommendation/track'
import {
  type FeedTrackingContext,
  useFeedImpressions,
} from '@/features/recommendation/use-impressions'
import { readNavMetrics } from '@/lib/nav-metrics'
import { notifyTabbarRoute } from '@/lib/tabbar-sync'
import { HOME_CATEGORIES, type ListingCategory, type MockListing } from '@/mock/api'
import { findUser } from '@/mock/users'
import { applyLoadResult, homeListState } from './list-state'
import { CATEGORY_SCROLL_DURATION, NAV_SETTLE_MS, resolveCategorySettle } from './nav-settle'
import './index.scss'

/** 瀑布流列宽（设计值 = 2×pt）：750 - 左右各 28 - 列间距 20，再除以 2 */
const COLUMN_WIDTH = 337

/** 设计稿的错落比例 → 图片区高度 */
const RATIO_HEIGHT: Record<MockListing['ratio'], number> = {
  '1x1': COLUMN_WIDTH,
  '4x5': Math.round((COLUMN_WIDTH * 5) / 4),
  '5x6': Math.round((COLUMN_WIDTH * 6) / 5),
  '3x4': Math.round((COLUMN_WIDTH * 4) / 3),
  '4x3': Math.round((COLUMN_WIDTH * 3) / 4),
}

function splitColumns(items: MockListing[]): [MockListing[], MockListing[]] {
  const left: MockListing[] = []
  const right: MockListing[] = []
  items.forEach((item, index) => {
    if (index % 2 === 0) left.push(item)
    else right.push(item)
  })
  return [left, right]
}

export default function Home() {
  const [items, setItems] = useState<MockListing[]>([])
  /**
   * 已经成功上屏的列表**属于哪个分类**（`null` = 还没成功加载过，或上一次加载失败已作废）。
   *
   * 与 `category`（用户刚点的那个）分开记：切分类时 `category` 立刻变，但屏幕上还是
   * 上一个分类的商品，两者不一致的这段时间必须显示加载态 —— 否则选中态已经跳到
   * 「教材书籍」、下面仍是推荐流的商品，用户会把旧数据当成新分类的结果
   * （#137 review P1）。`reqSeq` 只防旧响应覆盖新响应，防不了这一层错认。
   *
   * 失败时一并作废（置 `null`）：失败后 `items` 已被清空，屏幕上没有属于任何分类的
   * 有效数据；不置空的话，重试一个「上次成功过」的分类时会闪假空态（见 `resolveLoadedFor`）。
   *
   * 下拉刷新重拉的是**当前分类**，两者相等 → 不闪骨架屏，列表原地留着。
   */
  const [loadedFor, setLoadedFor] = useState<ListingCategory | 'ALL' | null>(null)
  /** 真实接口失败且没有回退 mock（生产口径）：显示错误态，不显示空态、更不显示演示数据 */
  const [failed, setFailed] = useState(false)

  /**
   * 当前分类。`ALL` = 首页的「推荐」，不是契约里的枚举值。
   *
   * 分类**不是另一个页面**：它与「推荐」同级，在首页原地切换（顶栏与悬浮底栏都保持不变），
   * 与消息页把通知并进「通知」tab 是同一套做法。
   */
  const [category, setCategory] = useState<ListingCategory | 'ALL'>('ALL')

  /**
   * 请求序号：连点分类时只认**最后一次**发出的结果。
   *
   * 用 ref 而不是 state：它只在回调里读写、不参与渲染。没有它的话，先发的请求后返回
   * 就会覆盖后发的结果 —— 连点「推荐 → 数码 → 教材书籍」时，用户看到的是数码的商品，
   * 而选中态在教材书籍上。
   */
  const reqSeq = useRef(0)

  /**
   * 埋点上下文：本次推荐请求的 `requestId` 与「公开 id → 全局 position」。
   *
   * 退 mock（开发 / 预览）或分类列表时 `requestId` 为 `null` —— 此时**不发** IMPRESSION /
   * QUICK_SKIP：契约强制这两个事件必须带 requestId + position，没有归因就发等于制造必然被拒的事件。
   */
  const [feedContext, setFeedContext] = useState<FeedTrackingContext>({
    requestId: null,
    positions: new Map(),
  })
  /**
   * 事件回调（点开 / 长按）里要读**最新**的上下文，但它们是随渲染重建的闭包 ——
   * 用 ref 兜住，免得把上下文塞进每个回调的依赖里、或在滚动时反复重建回调。
   */
  const feedContextRef = useRef(feedContext)
  feedContextRef.current = feedContext

  /** 曝光 / 快速划过的判定（观察器、计时、去重都在里面） */
  const impressions = useFeedImpressions({ items, contextRef: feedContextRef })

  /** 从推荐流上屏的卡片才有归因；分类列表与退 mock 都是 `null`（详情页照样发 DETAIL_VIEW，只是不带） */
  const attributionOf = (listingId: string): FeedAttribution | null => {
    const { requestId, positions } = feedContext
    const position = positions.get(listingId)
    if (!requestId || position === undefined) return null
    return { requestId, position }
  }

  /**
   * 长按卡片 →「不感兴趣」。
   *
   * R1 **没有**服务端隐藏接口（见 `recommendation/hidden`）：发一条 HIDE、立刻把卡片从列表
   * 移除、把 id 记进本地名单，三步都在本地完成。所以隐藏是立刻生效的，不需要等接口回来
   * ——也就不会出现「点了没反应」这种最容易被读成坏了的状态。
   */
  const onHideListing = async (item: MockListing) => {
    let confirmed = false
    try {
      const result = await Taro.showActionSheet({ itemList: ['不感兴趣'] })
      confirmed = result.tapIndex === 0
    } catch {
      // 用户点了取消 / 蒙层：`showActionSheet` 以 reject 收场，这不是错误
      return
    }
    if (!confirmed) return
    trackRecommendationEvent({
      listingId: item.id,
      eventType: 'HIDE',
      attribution: attributionOf(item.id),
    })
    hideListing(item.id)
    // 先结算它的曝光计时：卡片马上要被移除，留着计时器会在它消失之后补发一条曝光
    impressions.settleListing(item.id)
    setItems((prev) => prev.filter((row) => row.id !== item.id))
  }

  const load = async (next: ListingCategory | 'ALL') => {
    const seq = reqSeq.current + 1
    reqSeq.current = seq
    // 先摘掉错误态：上一个分类加载失败留下的错误块不属于 `next`，
    // 不摘的话切分类时会先闪一下「加载失败」再变骨架屏。
    setFailed(false)
    // 「真实接口优先、只有开发/预览才退 mock」由 fetchers 统一负责，页面不自己 try/catch。
    // `ALL` 是首页的「推荐」= 全部：契约的 `category` 没有 ALL 这个值，由 fetchers 决定不传。
    const result =
      next === 'ALL' ? await loadHomeFeed('ALL') : await loadCategoryListings(next, '综合')
    // 期间又切过分类：这次结果已经过期，丢弃（否则会把新分类的商品覆盖成旧分类的）
    if (seq !== reqSeq.current) return
    /*
      本地隐藏名单在这里过滤（R1 没有服务端隐藏接口，见 `recommendation/hidden`）。
      过滤发生在**取数之后、上屏之前**：`positions` 仍按服务端那份 feed 的原始下标算，
      重新编号会让后续曝光与详情归因整体错位。
    */
    const hidden = new Set(readHiddenListingIds())
    const visible = result.items.filter((item) => !hidden.has(item.id))
    /*
      三件套一次结转（纯函数，`./list-state.ts`）。`loadedFor` 的口径：
      成功 → 置为 `next`；**失败 → 作废为 `null`**（失败时 `items` 已被清成空数组，
      屏幕上没有属于任何分类的有效数据）。若失败时保留旧值，当失败的目标分类恰是
      上次成功过的那个时（失败后点「重试」、下拉刷新失败后重试、失败后切回该分类），
      `loadedFor === category` 成立，请求在途期间 `failed` 已清、`items` 仍为空 →
      渲染空态「这个分类还没有闲置」，把「没读到」说成「这个分类没货」。作废后
      `loadedFor !== category` 全程成立，重试期间由骨架屏接管；空态只在**真的成功
      拿到空列表**时出现。判定逻辑与用例见 `./list-state.ts`。
    */
    const applied = applyLoadResult({ requested: next, items: visible, failed: result.failed })
    // 上下文与列表同一次渲染生效：曝光观察器建起来时就已经能拿到 requestId 与序号
    setFeedContext({
      requestId: result.requestId ?? null,
      positions: result.positions ?? new Map(),
    })
    setItems(applied.items)
    setFailed(applied.failed)
    setLoadedFor(applied.loadedFor)
  }

  useLoad(() => {
    void load('ALL')
  })

  // 回到这个页面时补一次冲刷：队列里攒着的事件不该等到下一个 15s 定时器（见 `recommendation/queue`）
  useDidShow(() => {
    void flushRecommendationQueue()
  })

  // 下拉刷新重拉**当前分类**：在「教材书籍」里下拉刷新却跳回「推荐」，
  // 等于把用户刚选好的分类弄丢了。
  usePullDownRefresh(() => {
    void load(category).then(() => Taro.stopPullDownRefresh())
  })

  const [left, right] = useMemo(() => splitColumns(items), [items])

  /**
   * 商品区渲染形态：error / skeleton / empty / list。
   *
   * 判定是纯函数（`./list-state.ts`，带用例）：`loadedFor !== category` 时屏幕上的
   * 列表还没对上用户选的分类 —— 含首次进页（`loadedFor` 为 `null`，`items` 也为空，
   * 直接走空态判断会先闪一下「这个分类还没有闲置」再出商品）、切分类在途、
   * 以及加载失败作废后的重试在途。这几种情况都给骨架屏：既不能继续展示上一个
   * 分类的商品（旧数据冒充新分类），也不能显示空态（「没货」是成功后的结论）。
   */
  const listState = homeListState({ loadedFor, category, failed, itemCount: items.length })

  const goSearch = () => {
    void Taro.navigateTo({ url: '/pages/search/index' })
  }

  /**
   * 分类切换：**在原地换一批商品**，不跳页。
   *
   * 顶栏与悬浮底栏由首页自己持有，所以分类视图与「推荐」共用它们；
   * 商品列表按分类重新取数，卡片仍是首页那套瀑布流（`ProductCard`），不换成分类页的自绘卡。
   *
   * 切完的落点（Owner 2026-09-28 拍板，闲鱼口径）：滚到「文字导航刚好吸顶」的位置，
   * 不再回列表顶 —— 吸顶条下方正好是新一批商品的开头；页面还没滚到吸顶点时保持原位，
   * 不把用户往下拽。重复点**当前**分类不重新取数（没有新信息可拿），但也不是完全
   * no-op：失败态下当作「重试」，成功态只做落点归位。
   *
   * 归位期间（Owner 反馈「切换 tag 不需要抖动」）把吸顶判定**锁在当前值**：滚动动画
   * 途中 `scrollTop` 会贴着阈值来回、新分类列表替换时页面高度先塌再涨，两者都会让
   * `scrollTop >= pinAt` 瞬间翻 false，吸顶条滑出一半又被拽回 —— 视觉即抖动。
   * 锁到动画结束（`NAV_SETTLE_MS` > `CATEGORY_SCROLL_DURATION`）再恢复跟随。
   *
   * 「锁」只跟着**真的会发生滚动**的那一跳走（`resolveCategorySettle`）：页面还没过
   * 吸顶点时落点就是当前位置，这一跳不带位移、也不需要在途锁 —— 否则用户点完分类立刻
   * 下滑的那 260ms 里吸顶条出不来（判定被钉在旧值上，而此刻本该跟手出现）。
   */
  const onCategoryTap = (key: ListingCategory | 'ALL') => {
    // 已滚过吸顶点 → 归位到刚好吸顶；还没滚到 → 原地不动（`repositions` 同时决定是否上锁）
    const { target, repositions } = resolveCategorySettle(scrollTopRef.current, pinAt.current)
    if (repositions) lockNavSettle()
    else releaseNavSettle()
    if (key === category) {
      if (failed) void load(key)
      if (repositions)
        void Taro.pageScrollTo({ scrollTop: target, duration: CATEGORY_SCROLL_DURATION })
      return
    }
    setCategory(key)
    void load(key)
    if (repositions)
      void Taro.pageScrollTo({ scrollTop: target, duration: CATEGORY_SCROLL_DURATION })
  }

  /**
   * 顶栏高度：运行时读微信胶囊算出来的（见 `@/lib/nav-metrics`）。
   * 下面那条固定分类导航要落在它**下方**，所以用同一个来源，而不是写死一个数字。
   */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  /**
   * 纯文字分类导航（`home__catnav`）的显隐。
   *
   * 图标条**不吸顶**，随内容滚走；滚到它完全离开顶栏下沿之后，才在顶栏下方固定出这条
   * 文字导航。设计稿是「同一个元素吸顶后把图标高度收成 0」，但元素高度突变会把下面的
   * 瀑布流整体拽上去一截 —— 所以这里拆成两条：图标条正常滚走，文字条固定在流外。
   */
  const [catsPinned, setCatsPinned] = useState(false)
  /** 回到顶部钮（共享组件）：滚过一屏浮现 */
  const [showTop, setShowTop] = useState(false)
  const scrollTopRef = useRef(0)
  /** 图标条下沿越过顶栏下沿时的滚动位置；挂载后量一次 */
  const pinAt = useRef(Number.POSITIVE_INFINITY)
  /** 分类归位动画进行中：期间吸顶判定锁定（见 onCategoryTap 的抖动注释） */
  const navSettleRef = useRef(false)
  /** 归位锁的释放定时器。换一轮先清旧的、卸载时清掉，见 `lockNavSettle` */
  const navSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 按**当前**滚动位置重算吸顶态。锁定期间 `usePageScroll` 把判定钉在旧值上，解锁时
   * 必须自己补这一算（见 `lockNavSettle` 的注释）。
   */
  const syncCatsPinned = () => {
    const next = scrollTopRef.current >= pinAt.current
    // 值没变就把同一个值还回去，React 会跳过这轮渲染（与 `usePageScroll` 同口径）
    setCatsPinned((prev) => (prev === next ? prev : next))
  }

  /** 只清账（定时器 + 锁标志），不碰 React 状态 —— 卸载路径用它 */
  const clearNavSettle = () => {
    if (navSettleTimerRef.current) {
      clearTimeout(navSettleTimerRef.current)
      navSettleTimerRef.current = null
    }
    navSettleRef.current = false
  }

  /**
   * 上锁 / 解锁吸顶判定（`usePageScroll` 里据此决定跟不跟阈值）。
   *
   * 每次上锁都**先清掉上一轮的定时器**：连点 A→B→C 时，A 的定时器会在 C 的滚动动画
   * 还没跑完时把 `navSettleRef` 置回 false，判定随即在动画途中翻面 —— 正是这层锁要消除
   * 的抖动。计时从**最后一次**归位算起（审查 P2）。
   *
   * 解锁时**按当前位置重算一次**：锁定期间那些滚动事件都被强制成旧值了，解锁后若不再
   * 有滚动事件（用户已经停手），判定就会永远停在锁住的那一刻。端上实测过这条 ——
   * 归位那跳会被**骨架屏**的 maxScroll 夹住（列表替换时页面变矮，滚不到 `pinAt`），
   * 于是页面停在阈值以下、吸顶条却还挂着，与「回到顶部应淡化收起」自相矛盾。
   * 重算放在动画结束之后（`NAV_SETTLE_MS` > `CATEGORY_SCROLL_DURATION`），不会再引入抖动。
   *
   * 用全局 `setTimeout` 而不是 `window.setTimeout`（审查 P1）：真机的小程序逻辑层是
   * JSCore / V8 环境，没有浏览器 `window`，那行会抛 `ReferenceError`，分类切换在
   * `load()` / `pageScrollTo()` 之前就断掉。⚠️ **开发者工具测不出这条** —— 它的模拟器
   * 自己注入了浏览器式全局（实测 `typeof window === 'object'`、`window === globalThis`、
   * `window.setTimeout` 可用），`@tarojs/runtime` 则只把窗口对象挂在 `env` 上、不设全局
   * 别名。所以这里同时用 `tests/home-sticky-nav-wiring.test.ts` 按源码钉住写法。
   * 本仓 `login-confirm` / `user` 两页同此写法。
   */
  const lockNavSettle = () => {
    if (navSettleTimerRef.current) clearTimeout(navSettleTimerRef.current)
    navSettleRef.current = true
    navSettleTimerRef.current = setTimeout(() => {
      navSettleTimerRef.current = null
      navSettleRef.current = false
      syncCatsPinned()
    }, NAV_SETTLE_MS)
  }

  /** 这一跳不需要归位 → 别把上一轮的锁留着，判定立刻恢复跟随滚动 */
  const releaseNavSettle = () => {
    clearNavSettle()
    syncCatsPinned()
  }

  // 卸载清掉未释放的锁定时器：迟到的回调不该写回已销毁的页面（也不该再 setState）
  useUnload(clearNavSettle)

  useReady(() => {
    Taro.createSelectorQuery()
      .select('.home__cats-wrap')
      .boundingClientRect()
      .exec((res) => {
        const rect = res?.[0] as { top?: number; height?: number } | undefined
        // `boundingClientRect` 给的是视口坐标，加上当时的滚动量才是它在页面里的位置
        const measured =
          typeof rect?.top === 'number' && typeof rect?.height === 'number'
            ? rect.top + scrollTopRef.current + rect.height - navHeight
            : Number.NaN
        /**
         * 量不到（节点还没上屏）时的兜底。**单位是设备 px** —— 它要和 `usePageScroll`
         * 给的 `scrollTop` 比，别照设计稿的 rpx 写：rpx 在 750 宽的 H5 预览里 ≈ 1px，
         * 在 390pt 真机上 ≈ 0.52px。约 95px 是本机（图标条 ≈ 93px 高、距顶栏 4px）的实测位置。
         */
        pinAt.current = Number.isFinite(measured) ? Math.max(0, measured) : 95
      })
  })

  // 底栏选中态的真源是页面路径：本页 onShow 时广播一次（见 lib/tabbar-sync）
  useDidShow(notifyTabbarRoute)
  usePageScroll(({ scrollTop }) => {
    scrollTopRef.current = scrollTop
    // 分类归位动画期间吸顶判定锁定在当前值（防阈值边界抖动，见 onCategoryTap）
    const next = navSettleRef.current ? catsPinned : scrollTop >= pinAt.current
    // 滚动事件很密：值没变就把同一个值还回去，React 会跳过这轮渲染
    setCatsPinned((prev) => (prev === next ? prev : next))
    // 回到顶部钮：滚过一屏浮现（阈值随共享组件）
    setShowTop(scrollTop > BACK_TOP_THRESHOLD)
  })

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  return (
    <View className="home">
      <View className="home__hero-bg" />

      {/*
        固定顶栏：品牌 logo 在左、搜索胶囊居中。设计稿里这一行是 40pt
        （= 胶囊上留白 4 × 2 + 胶囊高 32），行高由组件按真机胶囊反推，不写死。
      */}
      <TopBar
        variant="glass"
        spacer
        left={
          <View className="home__logo-wrap">
            <Image className="home__logo" src={brandLogo} mode="aspectFit" />
          </View>
        }
        center={
          <View className="home__search" onClick={goSearch}>
            <Image className="home__search-cam" src={ICONS.camera} mode="aspectFit" />
            <Text className="home__search-ph">搜「键盘」「考研教材」</Text>
            <Image className="home__search-icon" src={ICONS.search} mode="aspectFit" />
          </View>
        }
      />

      <View className="home__cats-wrap">
        <ScrollView className="home__cats" scrollX enableFlex>
          <View className="home__cats-inner">
            {HOME_CATEGORIES.map((item) => (
              <View
                key={item.key}
                // 选中态跟随真实当前分类（此前硬编码「推荐」恒选中）
                // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child），
                // 与消息页 tab 的 `chat__tab--${key}` 同一做法
                className={`home__cat home__cat--${item.key}${item.key === category ? ' is-on' : ''}`}
                onClick={() => onCategoryTap(item.key)}
              >
                <View className="home__cat-ic">
                  <Image
                    className="home__cat-img"
                    src={HOME_CATEGORY_ICONS[item.key]}
                    mode="aspectFit"
                  />
                </View>
                <Text className="home__cat-label">{item.label}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>

      {/* 图标条滚出顶栏下沿之后，接管分类导航：纯文字 + 当前项下横杠。
          常驻渲染 + `is-pinned` 类切换过渡（Owner 2026-09-28 拍板）：
          下滑过阈值从顶栏下沿滑入弹出，回顶滑回并淡化，不再突然出现/消失。 */}
      <View
        className={`home__catnav${catsPinned ? ' is-pinned' : ''}`}
        style={{ top: `${navHeight}px` }}
      >
        <ScrollView className="home__catnav-scroll" scrollX enableFlex>
          <View className="home__catnav-inner">
            {HOME_CATEGORIES.map((item) => (
              <View
                key={item.key}
                // 与图标条同一份选中态来源，两条导航不会各说各话
                // `--${key}` 修饰类同样是为了端上自动化能定位到具体一项
                className={`home__catnav-item home__catnav-item--${item.key}${item.key === category ? ' is-on' : ''}`}
                onClick={() => onCategoryTap(item.key)}
              >
                <Text className="home__catnav-label">{item.label}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>

      <View className="home__grid">
        {listState === 'error' ? (
          <LoadError onRetry={() => void load(category)} />
        ) : listState === 'skeleton' ? (
          /*
            分类切换中 / 首次进页 / 失败后重试在途：列表还没对上当前分类，给骨架屏而不是
            继续展示上一个分类的商品（#137 review P1），也不是空态（那会被读成「这个分类没货」）。
          */
          <View className="waterfall">
            <View className="waterfall__col">
              {[0, 1].map((i) => (
                <View key={`sk-l-${i}`} className="home__skel">
                  <View className="home__skel-img" />
                  <View className="home__skel-bar" style={{ width: '76%' }} />
                  <View className="home__skel-bar" style={{ width: '42%' }} />
                </View>
              ))}
            </View>
            <View className="waterfall__col">
              {[0, 1].map((i) => (
                <View key={`sk-r-${i}`} className="home__skel">
                  <View className="home__skel-img" />
                  <View className="home__skel-bar" style={{ width: '68%' }} />
                  <View className="home__skel-bar" style={{ width: '36%' }} />
                </View>
              ))}
            </View>
          </View>
        ) : listState === 'empty' ? (
          <View className="home__empty">
            <Text className="home__empty-title">这个分类还没有闲置</Text>
            <Text className="home__empty-text">换个分类看看，或到许愿墙发一条心愿</Text>
          </View>
        ) : (
          <View className="waterfall">
            <View className="waterfall__col">
              {left.map((item) => (
                <ProductCard
                  key={item.id}
                  listing={item}
                  seller={findUser(item.sellerId)}
                  imageHeight={RATIO_HEIGHT[item.ratio]}
                  // 推荐归因随卡片带进详情页（R1 §3.5）；分类列表里为 null
                  attribution={attributionOf(item.id)}
                  // 点开前先记下「这张卡被点开过」：快速划过的判定要求「未点开」
                  onOpen={() => impressions.markOpened(item.id)}
                  onLongPress={() => void onHideListing(item)}
                />
              ))}
            </View>
            <View className="waterfall__col">
              {right.map((item) => (
                <ProductCard
                  key={item.id}
                  listing={item}
                  seller={findUser(item.sellerId)}
                  imageHeight={RATIO_HEIGHT[item.ratio]}
                  attribution={attributionOf(item.id)}
                  onOpen={() => impressions.markOpened(item.id)}
                  onLongPress={() => void onHideListing(item)}
                />
              ))}
            </View>
          </View>
        )}
      </View>

      {/* 回到顶部：Tab 页抬到底栏上方 */}
      <BackTop show={showTop} onTop={backToTop} bottom="170rpx" />
    </View>
  )
}
