import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import {
  categoryCount,
  categoryTitle,
  fetchCategoryListings,
  formatAmount,
  getUser,
  type ListingCategory,
  type MockListing,
  subCategoryCount,
  SUB_CATEGORIES,
  CATEGORY_ORDER,
} from '@/mock/api'
import './index.scss'

/**
 * C1 分类浏览（设计稿 `设计稿_C1-category.html`）。
 *
 * 左侧竖向一级分类栏（选中：白底 + 品牌色文字 + 左侧品牌色竖条）
 * ⇄ 右侧二级分类横滑胶囊 + 排序 + 两列瀑布流，左右联动。
 *
 * **与契约的边界**：契约的排序只有 `newest / priceAsc / priceDesc`，
 * **没有「综合」和「按成色」**（`listings/schema.ts:237`）。设计稿画了四项，
 * 这里按设计稿保留四个胶囊，但「成色」排序在前端本地做（`condition` 有值），
 * 「综合」用想要数 + 浏览量的加权——两者都不依赖后端新字段，接真实接口时再用服务端排序替换。
 */

type SortKey = '综合' | '最新' | '价格' | '成色'

const SORTS: SortKey[] = ['综合', '最新', '价格', '成色']

export default function Category() {
  const router = useRouter<{ category?: string }>()
  const initial = (router.params.category as ListingCategory | undefined) ?? 'DIGITAL'

  const [category, setCategory] = useState<ListingCategory>(
    CATEGORY_ORDER.includes(initial) ? initial : 'DIGITAL',
  )
  const [sub, setSub] = useState<string>('')
  const [sort, setSort] = useState<SortKey>('综合')
  const [items, setItems] = useState<MockListing[]>([])
  const [loading, setLoading] = useState(true)

  /**
   * 状态栏高度。分类页的顶部条是**吸顶的实心条**（不是漂浮钮），
   * 所以必须自己把状态栏那一条顶出来，否则标题会压到刘海与系统胶囊上。
   */
  const statusBarHeight = (() => {
    try {
      return Taro.getWindowInfo().statusBarHeight ?? 20
    } catch {
      return 20
    }
  })()

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  const subs = SUB_CATEGORIES[category] ?? []

  const load = async (next: ListingCategory) => {
    setLoading(true)
    const list = await fetchCategoryListings(next)
    setItems(list)
    setLoading(false)
  }

  useLoad(() => {
    const first = (SUB_CATEGORIES[category] ?? [])[0] ?? ''
    setSub(first)
    void load(category)
  })

  /** 切一级分类：二级收敛到第一个，并回到顶部（设计稿验收要求） */
  const pickCategory = (next: ListingCategory) => {
    if (next === category) return
    setCategory(next)
    setSub((SUB_CATEGORIES[next] ?? [])[0] ?? '')
    setSort('综合')
    void load(next)
  }

  /** 切二级：只筛不重新请求（同一份一级分类数据） */
  const pickSub = (next: string) => {
    if (next === sub) return
    setSub(next)
  }

  const shown = useMemo(() => {
    let list = items.filter((item) => !sub || item.sub === sub)
    if (sort === '最新') list = [...list].sort((a, b) => a.createdHoursAgo - b.createdHoursAgo)
    else if (sort === '价格') list = [...list].sort((a, b) => a.priceCents - b.priceCents)
    else if (sort === '成色') {
      const rank: Record<MockListing['condition'], number> = { NEW: 0, LIKE_NEW: 1, GOOD: 2, FAIR: 3 }
      list = [...list].sort((a, b) => rank[a.condition] - rank[b.condition])
    } else {
      list = [...list].sort((a, b) => b.wants * 3 + b.views - (a.wants * 3 + a.views))
    }
    return list
  }, [items, sub, sort])

  /** 两列交错：与首页瀑布流同一分列方式 */
  const [left, right] = useMemo(() => {
    const l: MockListing[] = []
    const r: MockListing[] = []
    shown.forEach((item, i) => (i % 2 === 0 ? l : r).push(item))
    return [l, r]
  }, [shown])

  const total = sub ? subCategoryCount(category, sub) : categoryCount(category)

  const openListing = (id: string) => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${id}` })
  }

  const card = (item: MockListing) => {
    const seller = getUser(item.sellerId)
    return (
      <View key={item.id} className="cat__card" onClick={() => openListing(item.id)}>
        <View className="cat__img">
          <Image className="cat__img-real" src={item.coverUrl} mode="aspectFill" />
          {item.free ? (
            <Text className="cat__corner cat__corner--free">0 元出</Text>
          ) : item.urgent ? (
            <Text className="cat__corner cat__corner--hot">急出</Text>
          ) : null}
        </View>
        <View className="cat__pbody">
          <Text className="cat__title">{item.title}</Text>
          <View className="cat__meta">
            <Text className="cat__price num">¥{formatAmount(item.priceCents)}</Text>
            {item.originalPriceCents ? (
              <Text className="cat__orig num">¥{formatAmount(item.originalPriceCents)}</Text>
            ) : null}
          </View>
          <View className="cat__seller">
            <View className="cat__av">
              <Text className="cat__av-tx">{seller.nickname.slice(0, 1)}</Text>
            </View>
            <Text className="cat__nm">{seller.nickname}</Text>
            <Text className="cat__campus">{seller.campus}</Text>
          </View>
        </View>
      </View>
    )
  }

  return (
    <View className="cat">
      {/* ---- 顶部：状态栏占位 + 返回 + 分类名 + 分类内搜索 ---- */}
      <View className="cat__status" style={{ height: `${statusBarHeight}px` }} />
      <View className="cat__cattop">
        <View className="cat__back" onClick={goBack}>
          <View className="cat__back-chevron" />
        </View>
        <Text className="cat__cattitle">
          {categoryTitle(category)}
          <Text className="cat__cattitle-num num">{`${categoryCount(category)} 件`}</Text>
        </Text>
        <View
          className="cat__icobtn"
          onClick={() => void Taro.navigateTo({ url: '/pages/search/index' })}
        >
          <Image className="cat__icobtn-img" src={ICONS.search} mode="aspectFit" />
        </View>
      </View>

      <View className="cat__body">
        {/* ---- 左栏：一级分类 ---- */}
        <ScrollView className="cat__rail" scrollY>
          {CATEGORY_ORDER.map((key) => (
            <View
              key={key}
              className={`cat__rail-item${key === category ? ' is-on' : ''}`}
              onClick={() => pickCategory(key)}
            >
              <Text className="cat__rail-label">{categoryTitle(key)}</Text>
              <Text className="cat__rail-c num">{categoryCount(key)}</Text>
            </View>
          ))}
        </ScrollView>

        {/* ---- 右栏：二级胶囊 + 排序 + 瀑布流 ---- */}
        <View className="cat__pane">
          <ScrollView className="cat__subtags" scrollX enableFlex>
            <View className="cat__subtags-inner">
              {subs.map((item) => (
                <View
                  key={item}
                  className={`cat__subtag${item === sub ? ' is-on' : ''}`}
                  onClick={() => pickSub(item)}
                >
                  <Text>{item}</Text>
                </View>
              ))}
            </View>
          </ScrollView>

          <View className="cat__sortrow">
            {SORTS.map((key) => (
              <View
                key={key}
                className={`cat__sort${key === sort ? ' is-on' : ''}`}
                onClick={() => setSort(key)}
              >
                <Text>{key}</Text>
              </View>
            ))}
            <Text className="cat__rnote num">{`${total} 件`}</Text>
          </View>

          <ScrollView className="cat__scroll" scrollY>
            {loading ? (
              <View className="cat__grid">
                {[0, 1, 2, 3].map((i) => (
                  <View key={`sk-${i}`} className="cat__skel">
                    <View className="cat__skel-img" />
                    <View className="cat__skel-lines">
                      <View className="cat__skel-bar" />
                      <View className="cat__skel-bar" style={{ width: '58%' }} />
                    </View>
                  </View>
                ))}
              </View>
            ) : shown.length === 0 ? (
              <View className="cat__empty">
                <View className="cat__empty-disc">
                  <Image className="cat__empty-ic" src={ICONS.box} mode="aspectFit" />
                </View>
                <Text className="cat__empty-title">这个分类还没有闲置</Text>
                <Text className="cat__empty-text">
                  换个二级分类看看，或者发一条许愿让同学来联系你
                </Text>
                <View
                  className="cat__empty-act"
                  onClick={() => void Taro.switchTab({ url: '/pages/wish/index' })}
                >
                  <Text>去许愿</Text>
                </View>
              </View>
            ) : (
              <View className="cat__grid">
                <View className="cat__col">{left.map((item) => card(item))}</View>
                <View className="cat__col">{right.map((item) => card(item))}</View>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </View>
  )
}
