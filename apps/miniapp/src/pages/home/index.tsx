import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePullDownRefresh } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import brandLogo from '@/assets/brand/logo.png'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import ProductCard from '@/components/product-card'
import {
  fetchHomeFeed,
  getUser,
  HOME_CATEGORIES,
  type ListingCategory,
  type MockListing,
} from '@/mock/api'
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
  const [category, setCategory] = useState<ListingCategory | 'ALL'>('ALL')
  const [items, setItems] = useState<MockListing[]>([])
  const [loading, setLoading] = useState(true)

  const load = async (next: ListingCategory | 'ALL') => {
    setLoading(true)
    const result = await fetchHomeFeed({ category: next, limit: 40 })
    setItems(result.items)
    setLoading(false)
  }

  useLoad(() => {
    void load('ALL')
  })

  usePullDownRefresh(() => {
    void load(category).then(() => Taro.stopPullDownRefresh())
  })

  const [left, right] = useMemo(() => splitColumns(items), [items])

  const goSearch = () => {
    void Taro.navigateTo({ url: '/pages/search/index' })
  }

  return (
    <View className="home">
      <View className="home__hero-bg" />

      <View className="home__hero">
        <View className="home__brandbar">
          <View className="home__logo-wrap">
            <Image className="home__logo" src={brandLogo} mode="aspectFit" />
          </View>
          <View
            className="home__iconbtn"
            onClick={() => void Taro.showToast({ title: '扫码能力待接入', icon: 'none' })}
          >
            <Image
              className="home__iconbtn-img"
              src={HOME_CATEGORY_ICONS.camera}
              mode="aspectFit"
            />
          </View>
        </View>

        <View className="home__search" onClick={goSearch}>
          <Image className="home__search-cam" src={ICONS.camera} mode="aspectFit" />
          <Text className="home__search-ph">搜「键盘」「考研教材」</Text>
          <Image className="home__search-icon" src={ICONS.search} mode="aspectFit" />
        </View>
      </View>

      <View className="home__cats-wrap">
        <ScrollView className="home__cats" scrollX enableFlex>
          <View className="home__cats-inner">
            {HOME_CATEGORIES.map((item) => {
              const on = item.key === category
              return (
                <View
                  key={item.key}
                  className={`home__cat${on ? ' is-on' : ''}`}
                  onClick={() => {
                    setCategory(item.key)
                    void load(item.key)
                  }}
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
              )
            })}
          </View>
        </ScrollView>
      </View>

      <View className="home__grid">
        {items.length === 0 && !loading ? (
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
                  seller={getUser(item.sellerId)}
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
                  seller={getUser(item.sellerId)}
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
