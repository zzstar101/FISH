import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useMemo, useRef, useState } from 'react'
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
 * **没有「综合」和「按成色」**（`listings/schema.ts:237`）。设计稿画了四项，这里按设计稿
 * 保留四个胶囊，但两者的语义都要打折，且**真实数据与 mock 回落的表现不同**：
 *
 * - **mock 回落**：`items` 带 `wants` / `views` / `condition`，所以「综合」按热度加权、
 *   「成色」按 `condition` 排序，都是真的。
 * - **真实数据**：契约既没有热度计数、成色也不是排序键，所以
 *   `fetchers.toListingSort` 把「综合」映射成 `newest`，「成色」在前端本地按 `condition` 排
 *   （`condition` 契约里有，这个仍然成立）。因此真实数据下**「综合」与「最新」的排序结果相同**
 *   —— 两个胶囊一个行为。这是真实能力的边界，不假装支持。
 *
 * 另外「价格」只对**已取回的那一页**排序（`limit=50`）：它走的是本地排序 + `priceAsc` 请求，
 * 商品总数超过一页时「最便宜」不等于全站最便宜。要真正全站排序需要滚动分页，不在本次范围。
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
   * 数据来源，**三态**：
   * - `null`：还没有拿到过结果（首屏 / 切分类途中）—— 此时**不能**当作 mock，
   *   否则真实环境下首屏与每次切分类都会先闪一批 fixture 的计数与二级胶囊，
   *   并且标题会先显示 `0 件`、切分类时还会显示**上一个分类**的件数。
   * - `false`：确实走的是 mock 回退，fixture 的计数与二级胶囊是真实的，照常显示。
   * - `true`：来自真实接口，隐藏契约不支持的件。
   *
   * 为什么必须有这个三态：**二级分类与「N 件」统计在契约里不存在**
   * （`ListingCardSchema` 无二级分类字段，也没有分类计数端点），只有 mock fixture 有。
   * 拿真实数据时若照旧渲染它们，就会出现「二级胶囊把整页筛空」与「真商品 + 假计数」。
   */
  const [fromApi, setFromApi] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * 请求序号：连点分类时只认**最后一次**发出的请求结果。
   *
   * 用 ref 而不是 state：它只在回调里读写、不参与渲染，用 state 反而会因为
   * 异步更新拿到过期的值。没有它的话，先发的请求后返回就会覆盖后发的结果，
   * 用户看到的是另一个分类的商品。
   */
  const reqSeq = useRef(0)

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
   * 二级分类胶囊**只在 mock 回退确认之后**才出现。
   *
   * 契约没有二级分类（`ListingCardSchema` 无此字段，`adapt.ts` 因此投影成空串），
   * 真实数据下这些胶囊点了会把整页筛成空 —— 这是一个「看起来能点、实际没有意义」的控件，
   * 比不显示更糟。`fromApi === false` 才说明确实拿到了 fixture 数据；
   * `null`（还没结果）时同样不显示，避免首屏闪一批点了没用的胶囊。
   */
  const subs = fromApi === false ? (SUB_CATEGORIES[category] ?? []) : []

  const load = async (next: ListingCategory, sortLabel: SortKey) => {
    setLoading(true)
    const seq = reqSeq.current + 1
    reqSeq.current = seq
    // 「真实接口优先、失败退 mock」由 fetchers 统一负责；排序标签原样交过去由它映射成契约排序
    const { items: list, fromApi: real } = await loadCategoryListings(next, sortLabel)
    // 期间又切过分类：这次结果已经过期，丢弃（否则会把新分类的商品覆盖成旧分类的）
    if (seq !== reqSeq.current) return
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
          {/* 件数只在拿到结果后显示：否则首屏会先闪一个 `0 件`，
              切分类时还会显示**上一个分类**的件数（items 要等 await 才换）。
              真实数据下也没有全站分类统计端点，所以只报本次请求拿到的条数。 */}
          {fromApi === null ? null : (
            <Text className="cat__cattitle-num num">{`${items.length} 件`}</Text>
          )}
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
                  只有确认是 mock 回退时才显示 fixture 的计数；真实数据与「还没结果」都不显示 —— 不编一个。 */}
              {fromApi === false ? (
                <Text className="cat__rail-c num">{categoryCount(key)}</Text>
              ) : null}
            </View>
          ))}
        </ScrollView>

        {/* ---- 右栏：二级胶囊 + 排序 + 瀑布流 ---- */}
        <View className="cat__pane">
          {/* 没有二级胶囊时整个容器都不渲染：否则 `.cat__subtags` 的 padding-bottom
              会在排序行上方留一条 20px 的空白带 */}
          {subs.length > 0 ? (
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
          ) : null}

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
            {/* 计数与栅格同步：加载途中显示上一个分类的件数会误导 */}
            {loading ? null : <Text className="cat__rnote num">{`${total} 件`}</Text>}
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
