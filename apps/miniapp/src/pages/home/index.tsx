import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePageScroll, usePullDownRefresh, useReady } from '@tarojs/taro'
import { useMemo, useRef, useState } from 'react'
import brandLogo from '@/assets/brand/logo.png'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import LoadError from '@/components/load-error'
import ProductCard from '@/components/product-card'
import TopBar from '@/components/top-bar'
import { loadCategoryListings, loadHomeFeed } from '@/features/fetchers'
import { readNavMetrics } from '@/lib/nav-metrics'
import { HOME_CATEGORIES, type ListingCategory, type MockListing } from '@/mock/api'
import { findUser } from '@/mock/users'
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
   * 已经成功上屏的列表**属于哪个分类**（`null` = 还没成功加载过）。
   *
   * 与 `category`（用户刚点的那个）分开记：切分类时 `category` 立刻变，但屏幕上还是
   * 上一个分类的商品，两者不一致的这段时间必须显示加载态 —— 否则选中态已经跳到
   * 「教材书籍」、下面仍是推荐流的商品，用户会把旧数据当成新分类的结果
   * （#137 review P1）。`reqSeq` 只防旧响应覆盖新响应，防不了这一层错认。
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
   * 当前屏幕上的列表是否还没对上用户选的分类。
   *
   * 首次进页 `loadedFor === null` 也算未对上：`items` 初始为空，若直接走空态判断，
   * 会先闪一下「这个分类还没有闲置」再出现商品。
   */
  const pending = loadedFor !== category

  /**
   * 请求序号：连点分类时只认**最后一次**发出的结果。
   *
   * 用 ref 而不是 state：它只在回调里读写、不参与渲染。没有它的话，先发的请求后返回
   * 就会覆盖后发的结果 —— 连点「推荐 → 数码 → 教材书籍」时，用户看到的是数码的商品，
   * 而选中态在教材书籍上。
   */
  const reqSeq = useRef(0)

  const load = async (next: ListingCategory | 'ALL') => {
    const seq = reqSeq.current + 1
    reqSeq.current = seq
    // 先摘掉错误态：上一个分类加载失败留下的错误块不属于 `next`，
    // 不摘的话切分类时会先闪一下「加载失败」再变骨架屏。
    setFailed(false)
    // 「真实接口优先、只有开发/预览才退 mock」由 fetchers 统一负责，页面不自己 try/catch。
    // `ALL` 是首页的「推荐」= 全部：契约的 `category` 没有 ALL 这个值，由 fetchers 决定不传。
    const { items: list, failed: nextFailed } =
      next === 'ALL' ? await loadHomeFeed('ALL') : await loadCategoryListings(next, '综合')
    // 期间又切过分类：这次结果已经过期，丢弃（否则会把新分类的商品覆盖成旧分类的）
    if (seq !== reqSeq.current) return
    setItems(list)
    setFailed(nextFailed)
    // 这一批商品属于 `next`：`pending` 随之关掉，骨架屏换成真实列表
    setLoadedFor(next)
  }

  useLoad(() => {
    void load('ALL')
  })

  // 下拉刷新重拉**当前分类**：在「教材书籍」里下拉刷新却跳回「推荐」，
  // 等于把用户刚选好的分类弄丢了。
  usePullDownRefresh(() => {
    void load(category).then(() => Taro.stopPullDownRefresh())
  })

  const [left, right] = useMemo(() => splitColumns(items), [items])

  const goSearch = () => {
    void Taro.navigateTo({ url: '/pages/search/index' })
  }

  /**
   * 分类切换：**在原地换一批商品**，不跳页。
   *
   * 顶栏与悬浮底栏由首页自己持有，所以分类视图与「推荐」共用它们；
   * 商品列表按分类重新取数，卡片仍是首页那套瀑布流（`ProductCard`），不换成分类页的自绘卡。
   *
   * 切完回到顶部：用户多半是在吸顶的纯文字条上点的分类（此时页面已滚过一屏），
   * 不回顶的话新商品从半截开始显示，看不出「换过一批」。
   */
  const onCategoryTap = (key: ListingCategory | 'ALL') => {
    if (key === category) return
    setCategory(key)
    void load(key)
    void Taro.pageScrollTo({ scrollTop: 0, duration: 200 })
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
  const scrollTopRef = useRef(0)
  /** 图标条下沿越过顶栏下沿时的滚动位置；挂载后量一次 */
  const pinAt = useRef(Number.POSITIVE_INFINITY)

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

  usePageScroll(({ scrollTop }) => {
    scrollTopRef.current = scrollTop
    const next = scrollTop >= pinAt.current
    // 滚动事件很密：值没变就把同一个值还回去，React 会跳过这轮渲染
    setCatsPinned((prev) => (prev === next ? prev : next))
  })

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

      {/* 图标条滚出顶栏下沿之后，接管分类导航：纯文字 + 当前项下横杠 */}
      {catsPinned ? (
        <View className="home__catnav" style={{ top: `${navHeight}px` }}>
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
      ) : null}

      <View className="home__grid">
        {failed ? (
          <LoadError onRetry={() => void load(category)} />
        ) : pending ? (
          /*
            分类切换中 / 首次进页：列表还没对上当前分类，给骨架屏而不是继续展示
            上一个分类的商品（#137 review P1），也不是空态（那会被读成「这个分类没货」）。
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
        ) : items.length === 0 ? (
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
                  variant="home"
                  imageHeight={RATIO_HEIGHT[item.ratio]}
                />
              ))}
            </View>
            <View className="waterfall__col">
              {right.map((item) => (
                <ProductCard
                  key={item.id}
                  listing={item}
                  seller={findUser(item.sellerId)}
                  variant="home"
                  imageHeight={RATIO_HEIGHT[item.ratio]}
                />
              ))}
            </View>
          </View>
        )}
      </View>
    </View>
  )
}
