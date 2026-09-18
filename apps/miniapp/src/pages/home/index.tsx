import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import brandLogo from '@/assets/brand/logo.png'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import LoadError from '@/components/load-error'
import ProductCard from '@/components/product-card'
import TopBar from '@/components/top-bar'
import { loadHomeFeed } from '@/features/fetchers'
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
  const [loading, setLoading] = useState(true)
  /** 真实接口失败且没有回退 mock（生产口径）：显示错误态，不显示空态、更不显示演示数据 */
  const [failed, setFailed] = useState(false)

  const load = async () => {
    setLoading(true)
    // 「真实接口优先、只有开发/预览才退 mock」由 fetchers 统一负责，页面不自己 try/catch。
    // 只取「推荐」= 全部：其余分类在这里是**跳转**到分类页（见 onCategoryTap），不在本页停留。
    const { items: list, failed: nextFailed } = await loadHomeFeed('ALL')
    setItems(list)
    setFailed(nextFailed)
    setLoading(false)
  }

  useLoad(() => {
    void load()
  })

  usePullDownRefresh(() => {
    void load().then(() => Taro.stopPullDownRefresh())
  })

  const [left, right] = useMemo(() => splitColumns(items), [items])

  const goSearch = () => {
    void Taro.navigateTo({ url: '/pages/search/index' })
  }

  /**
   * 分类圆盘：**进入对应的分类页**，而不是在原地筛瀑布流。
   *
   * 分类页（`pages/category/index.tsx`）本来就读 `?category=` 参数，但此前全仓无人传值，
   * 是个死参数；这里把它接上。参数只传契约枚举值（`BOOKS` / `DIGITAL` …），
   * 分类页自己会把「不在枚举内」的值回落到默认分类。
   *
   * 「推荐」不是分类，它是「全部」——留在首页把瀑布流恢复成完整列表。
   */
  const onCategoryTap = (key: ListingCategory | 'ALL') => {
    if (key === 'ALL') {
      void load()
      return
    }
    void Taro.navigateTo({ url: `/pages/category/index?category=${key}` })
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

  useEffect(() => {
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
        // 量不到（时序问题）就退一个保守值：图标条本身约 150rpx 高
        pinAt.current = Number.isFinite(measured) ? Math.max(0, measured) : 150
      })
  }, [navHeight])

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
                // 「推荐」恒为当前项：其余分类点了就跳去分类页，不在本页停留
                className={`home__cat${item.key === 'ALL' ? ' is-on' : ''}`}
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
                  // 同图标条：「推荐」恒为当前项，其余分类点了跳分类页
                  className={`home__catnav-item${item.key === 'ALL' ? ' is-on' : ''}`}
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
          <LoadError onRetry={() => void load()} />
        ) : items.length === 0 && !loading ? (
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
