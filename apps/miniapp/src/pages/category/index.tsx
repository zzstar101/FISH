import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { loadCategoryListings } from '@/features/fetchers'
import {
  CATEGORY_ORDER,
  categoryCount,
  categoryTitle,
  formatAmount,
  type ListingCategory,
  type MockListing,
  SUB_CATEGORIES,
} from '@/mock/api'
import { findUser } from '@/mock/users'
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

/**
 * 「综合」排序的热度分：想要数权重是浏览量的 3 倍。
 *
 * 契约里没有 `views` / `wants`，真实数据下两者都是 `null`。比较函数必须给出**全序**，
 * 所以这里把 `null` 当 0 参与计算——只是说「它在热度上不贡献分」，不是假装没人想要。
 * 不给缺值商品提前 `return 0`：那会让缺值商品之间顺序取决于原数组次序，看起来像随机。
 */
function heat(item: MockListing): number {
  return (item.wants ?? 0) * 3 + (item.views ?? 0)
}

export default function Category() {
  const router = useRouter<{ category?: string }>()
  const initial = (router.params.category as ListingCategory | undefined) ?? 'DIGITAL'

  const [category, setCategory] = useState<ListingCategory>(
    CATEGORY_ORDER.includes(initial) ? initial : 'DIGITAL',
  )
  const [sub, setSub] = useState<string>('')
  const [sort, setSort] = useState<SortKey>('综合')
  const [items, setItems] = useState<MockListing[]>([])
  /**
   * 本页数据是「真接口来的」还是「回退到 mock 的」。
   *
   * 这个标记是必要的，不是可选优化：**二级分类与「N 件」统计在契约里不存在**
   * （`ListingCardSchema` 没有二级分类字段，也没有分类计数端点），只有 mock fixture 有。
   * 拿真实数据时若照旧渲染它们，就会出现两种错：二级胶囊按 fixture 的默认值把整页筛空、
   * 以及「真商品 + 假计数」。所以来源要显式传下来，页面据此隐藏这些件。
   */
  const [fromApi, setFromApi] = useState(false)
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

  /**
   * 二级分类胶囊**只在 mock 回退时**才出现。
   *
   * 契约没有二级分类（`ListingCardSchema` 无此字段，`adapt.ts` 因此投影成空串），
   * 真实数据下这些胶囊点了会把整页筛成空 —— 这是一个「看起来能点、实际没有意义」的控件，
   * 比不显示更糟。所以真实数据时不渲染这一行（左侧一级分类 + 排序仍然可用）。
   */
  const subs = fromApi ? [] : (SUB_CATEGORIES[category] ?? [])

  const load = async (next: ListingCategory, sortLabel: SortKey) => {
    setLoading(true)
    // 「真实接口优先、失败退 mock」由 fetchers 统一负责；排序标签原样交过去由它映射成契约排序
    const { items: list, fromApi: real } = await loadCategoryListings(next, sortLabel)
    setItems(list)
    setFromApi(real)
    // 二级筛选只在有二级信息时才有默认值：mock 沿用「第一个胶囊」的既有观感，
    // 真实数据下必须清空，否则拿 fixture 的胶囊值去筛空串会筛掉全部商品。
    setSub(real ? '' : ((SUB_CATEGORIES[next] ?? [])[0] ?? ''))
    setLoading(false)
  }

  useLoad(() => {
    void load(category, sort)
  })

  /** 切一级分类：二级收敛到第一个，并回到顶部（设计稿验收要求） */
  const pickCategory = (next: ListingCategory) => {
    if (next === category) return
    setCategory(next)
    setSort('综合')
    void load(next, '综合')
  }

  /** 切二级：只筛不重新请求（同一份一级分类数据） */
  const pickSub = (next: string) => {
    if (next === sub) return
    setSub(next)
  }

  const shown = useMemo(() => {
    let list = sub && !fromApi ? items.filter((item) => item.sub === sub) : items
    if (sort === '最新') list = [...list].sort((a, b) => a.createdHoursAgo - b.createdHoursAgo)
    else if (sort === '价格') list = [...list].sort((a, b) => a.priceCents - b.priceCents)
    else if (sort === '成色') {
      const rank: Record<MockListing['condition'], number> = {
        NEW: 0,
        LIKE_NEW: 1,
        GOOD: 2,
        FAIR: 3,
      }
      list = [...list].sort((a, b) => rank[a.condition] - rank[b.condition])
    } else {
      // 综合：想要数 + 浏览量加权，热度高的在前
      list = [...list].sort((a, b) => heat(b) - heat(a))
    }
    return list
  }, [items, sub, sort, fromApi])

  /** 两列交错：与首页瀑布流同一分列方式 */
  const [left, right] = useMemo(() => {
    const l: MockListing[] = []
    const r: MockListing[] = []
    shown.forEach((item, i) => {
      if (i % 2 === 0) l.push(item)
      else r.push(item)
    })
    return [l, r]
  }, [shown])

  /**
   * 计数一律**从已加载的数据算**，不再读 mock fixture 的 `categoryCount` / `subCategoryCount`：
   * 那两张表数的是 fixture 的条目，跟真实接口返回的列表没有关系，混在一起就是「真商品 + 假计数」。
   * mock 回退时两者本来就等值（同一份 fixture、同一套 ACTIVE 过滤），所以观感不变。
   */
  const total = shown.length

  const openListing = (id: string) => {
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${id}` })
  }

  const card = (item: MockListing) => {
    const seller = findUser(item.sellerId)
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
          {/* 真实列表卡没有卖家字段（sellerId 是空串哨兵 → findUser 给 null）：整行不渲染，不编一个卖家 */}
          {seller ? (
            <View className="cat__seller">
              <View className="cat__av">
                <Text className="cat__av-tx">{seller.nickname.slice(0, 1)}</Text>
              </View>
              <Text className="cat__nm">{seller.nickname}</Text>
              <Text className="cat__campus">{seller.campus}</Text>
            </View>
          ) : null}
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
          {/* 真实数据下只有「当前分类」的条目数（本次请求拿到的），没有全站分类统计端点；
              这里用 items.length 而不是 fixture 的 categoryCount，避免真商品配假数字 */}
          <Text className="cat__cattitle-num num">{`${items.length} 件`}</Text>
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
              {/* 每个一级分类的在售件数需要全站统计，契约没有这个端点。
                  mock 回退时 fixture 里有，照常显示；真实数据下没有就不显示数字 —— 不编一个。 */}
              {fromApi ? null : <Text className="cat__rail-c num">{categoryCount(key)}</Text>}
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
                {/* 真实数据下二级胶囊整行不渲染（契约没有这个维度），
                    所以文案不能再让人去点一个不存在的控件 */}
                <Text className="cat__empty-text">
                  {subs.length > 0
                    ? '换个二级分类看看，或者发一条许愿让同学来联系你'
                    : '发一条许愿让同学来联系你，或者看看其他分类'}
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
