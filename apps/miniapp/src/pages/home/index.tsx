import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePullDownRefresh } from '@tarojs/taro'
import { useMemo, useState } from 'react'
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
   * 分类横滑条的吸顶位置：要落在固定顶栏**下方**，否则会被顶栏盖住。
   * 顶栏高度是运行时读微信胶囊算出来的（见 `@/lib/nav-metrics`），
   * 所以这里也用同一个来源，而不是写一个 `top: 0` 或猜一个数字。
   */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  return (
    <View className="home">
      <View className="home__hero-bg" />

      {/*
        固定顶栏：品牌 logo 在左、搜索胶囊居中。设计稿里这一行是 40pt
        （= 胶囊上留白 4 × 2 + 胶囊高 32），行高由组件按真机胶囊反推，不写死。
      */}
      <TopBar
        variant="plain"
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

      <View className="home__cats-wrap" style={{ top: `${navHeight}px` }}>
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
