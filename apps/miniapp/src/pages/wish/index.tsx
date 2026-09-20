import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import TopBar from '@/components/top-bar'
import {
  categoryLabel,
  closeWishLocal,
  formatAmount,
  formatYuan,
  type MatchView,
  type MockWish,
  type MockWishPoolItem,
  matchedListings,
  myWishes,
  POOL_MIN_COUNT,
  WISH_CATEGORIES,
  wishPool,
} from '@/mock/api'
import './index.scss'

/**
 * 许愿（一级 Tab 页）。设计稿 `许愿墙-改版设计-按契约.html` 的屏①「我的愿望」
 * 与屏②「愿望池」**合并成同一页的两个页内 tab**（Owner 指示：愿望池不是独立页面）。
 *
 * 版式：顶栏玻璃（两段式标题「许愿墙」+ 副行一级 tab，照消息页 `pages/chat` 的做法）
 * → 热门求购卡 → 区块标题行（+「我要许愿」）→ 二级筛选横滑胶囊 → 卡片列表。
 *
 * 与上一版（吊牌 / bento 两卡 / 愿望成真 / 最近的心愿）相比，稿把那些区块全部删掉了，
 * 换成了 `.mw`（我的愿望卡）与 `.pool`（愿望池卡）两种卡。
 *
 * 数据仍全部来自 `@/mock/api`（本页**零业务请求**，见 `preview/verify-mock-only.mjs`）。
 */

/** 一级 tab：我的愿望 / 愿望池 */
type TabKey = 'mine' | 'pool'

/** 我的愿望的二级筛选：对应契约 `wishStatusSchema`，「全部」= 不筛 */
const MINE_FILTERS: { key: 'ALL' | MockWish['status']; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'ACTIVE', label: '许愿中' },
  { key: 'FULFILLED', label: '已完成' },
  { key: 'CLOSED', label: '已关闭' },
]

/**
 * 状态胶囊的色调与文案。
 *
 * 稿里三种状态是三档浅底，这里复用仓库既有的 `@include status-pill` 色调语言
 * （is-pending / is-done / is-cancel），避免为一张卡新造一套色。
 */
const STATUS_PILL: Record<MockWish['status'], string> = {
  ACTIVE: 'is-pending',
  FULFILLED: 'is-done',
  CLOSED: 'is-cancel',
}

const STATUS_TEXT: Record<MockWish['status'], string> = {
  ACTIVE: '许愿中',
  FULFILLED: '已完成',
  CLOSED: '已关闭',
}

/** 热门求购折叠时展示的条数（稿是两列四行 = 8 条） */
const HOT_ROWS = 8

/** 卡片内嵌的命中行最多展示几条（稿是 3 条） */
const HIT_ROWS = 3

/** 预算区间文案：设计稿是「¥30–50」（中间用 en dash，不是 hyphen） */
function budgetRange(minCents: number, maxCents: number): string {
  return `¥${formatAmount(minCents)}–${formatAmount(maxCents)}`
}

/** 命中行的发布时间：稿是「2 小时前发布」，mock 只给相对小时数 */
function timeAgo(hoursAgo: number): string {
  if (hoursAgo < 1) return '刚刚'
  if (hoursAgo < 24) return `${Math.round(hoursAgo)} 小时前`
  const days = Math.round(hoursAgo / 24)
  return days <= 1 ? '昨天' : `${days} 天前`
}

/** 命中商品行（`.mw` 卡内嵌的「愿望成真」列表） */
function HitRow({ view }: { view: MatchView }) {
  const { match, listing } = view
  return (
    <View
      className="wishhit"
      onClick={() => void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })}
    >
      <View className="wishhit__thumb">
        <Image className="wishhit__img" src={listing.coverUrl} mode="aspectFill" />
      </View>
      <View className="wishhit__main">
        <Text className="wishhit__title">{listing.title}</Text>
        <Text className="wishhit__time">{timeAgo(listing.createdHoursAgo)}发布</Text>
      </View>
      <View className="wishhit__right">
        <Text className="wishhit__price">{formatYuan(listing.priceCents)}</Text>
        <Text className="wishhit__score">{match.score}% 匹配</Text>
      </View>
    </View>
  )
}

export default function Wish() {
  const [tab, setTab] = useState<TabKey>('mine')
  const [mineFilter, setMineFilter] = useState<'ALL' | MockWish['status']>('ALL')
  const [poolFilter, setPoolFilter] = useState<'ALL' | MockWishPoolItem['category']>('ALL')
  const [hotOpen, setHotOpen] = useState(false)
  /**
   * 本地写（关闭愿望 / 发布愿望）改的是 mock fixture，React 不会知道，
   * 所以用这个计数器强制重算；`useDidShow` 覆盖「从发布页返回」这条路径 ——
   * Tab 页被返回时不会重新挂载，只会重新显示。
   */
  const [revision, setRevision] = useState(0)
  useDidShow(() => setRevision((value) => value + 1))
  // `revision` 只用来让下面的取值在本地写之后重跑一遍（值本身不参与计算），
  // 所以这里刻意不用 `useMemo` —— 直接每次渲染现算，避免「多声明一个依赖」的误读
  void revision

  const pool = wishPool()
  const mine = [...myWishes()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const mineList = mineFilter === 'ALL' ? mine : mine.filter((wish) => wish.status === mineFilter)
  const poolList = poolFilter === 'ALL' ? pool : pool.filter((item) => item.category === poolFilter)

  /** 每个二级筛选上的计数：前端从 items 现算（契约没有计数端点） */
  const mineCount = (key: 'ALL' | MockWish['status']) =>
    key === 'ALL' ? mine.length : mine.filter((wish) => wish.status === key).length
  const poolCount = (key: 'ALL' | MockWishPoolItem['category']) =>
    key === 'ALL' ? pool.length : pool.filter((item) => item.category === key).length

  /** 分类筛选的选项：8 个枚举值按契约顺序（与首页横滑分类同一套中文名） */
  const poolCategories = WISH_CATEGORIES

  const hotTop = pool[0]?.wantCount ?? 1
  const hotList = hotOpen ? pool : pool.slice(0, HOT_ROWS)

  const goSearch = (keyword: string) => {
    // 搜索页读的是 `q`（`pages/search/index.tsx`），不是稿里的 `kw`
    void Taro.navigateTo({ url: `/pages/search/index?q=${encodeURIComponent(keyword)}` })
  }

  const closeWish = (wish: MockWish) => {
    if (!closeWishLocal(wish.id)) return
    setRevision((value) => value + 1)
    void Taro.showToast({ title: '已关闭这条愿望', icon: 'none' })
  }

  return (
    <View className="wish">
      <View className="wish__topbg" />

      {/*
        顶栏：主行是两段式标题「许愿墙」，副行是页内一级 tab（与消息页同一套做法）。
        副行的占位由下方 `wish__header-gap` 补 —— 组件的 `spacer` 只含主行。
      */}
      <TopBar
        variant="glass"
        spacer
        title="许愿"
        titleEm="墙"
        below={
          <View className="wish__tabs">
            {(
              [
                { key: 'mine', label: '我的愿望', count: mine.length },
                { key: 'pool', label: '愿望池', count: pool.length },
              ] as const
            ).map((item) => {
              const on = item.key === tab
              return (
                <View
                  key={item.key}
                  className={`wish__tab wish__tab--${item.key}${on ? ' is-on' : ''}`}
                  onClick={() => setTab(item.key)}
                >
                  <Text>{item.label}</Text>
                  <Text className="wish__tab-n">{item.count}</Text>
                </View>
              )
            })}
          </View>
        }
      />
      <View className="wish__header-gap" />

      <View className="wish__body">
        {/* ---- 热门求购：白卡 + 顶部渐变条 + 两列 + 热度条 ---- */}
        <View className="hot">
          <View className="hot__hd">
            <Text className="hot__title">热门求购</Text>
            {/*
              「近 7 天」是设计稿的产品口径，**不是**过滤条件：`/wishes/pool` 的聚合
              （后端 `aggregatePool` 与 mock 的 `wishPoolItems`）都只看 `status = ACTIVE`，
              没有时间窗。当前 fixture 全部落在 7 天内（6~66 小时），所以这句话成立；
              真接了接口、池子里出现更早的愿望之后，要么改这句文案、要么给聚合加时间窗。
              稿在愿望池 tab 会把这里换成 `GET /wishes/pool · k-匿名聚合`（开发向文案），
              本页两个 tab 统一用这句用户可读的。
            */}
            <Text className="hot__note">近 7 天 · 按想要人数</Text>
          </View>
          <View className="hot__grid">
            {hotList.map((item, index) => (
              <View
                key={item.keyword}
                className={`hot__row${index < 3 ? ' is-top' : ''}`}
                onClick={() => goSearch(item.keyword)}
              >
                <Text className="hot__no">{String(index + 1).padStart(2, '0')}</Text>
                <View className="hot__main">
                  <Text className="hot__kw">{item.keyword}</Text>
                  <View className="hot__bar">
                    <View
                      className="hot__bar-fill"
                      // 榜首 100%，其余按比例；分母用榜首值而不是总和，视觉差异才明显
                      style={{ width: `${Math.round((item.wantCount / hotTop) * 100)}%` }}
                    />
                  </View>
                </View>
              </View>
            ))}
          </View>
          {pool.length > HOT_ROWS ? (
            <View
              className={`hot__more${hotOpen ? ' is-open' : ''}`}
              onClick={() => setHotOpen((value) => !value)}
            >
              <Text>{hotOpen ? '收起' : `展示全部 ${pool.length} 个标签`}</Text>
              <Image
                className="hot__more-ic"
                src={hotOpen ? ICONS.chevronUpMuted : ICONS.chevronDownMuted}
                mode="aspectFit"
              />
            </View>
          ) : null}
        </View>

        {/* ---- 区块标题行：我的愿望挂发布入口，愿望池挂排序说明（同稿） ---- */}
        <View className="wish__sec">
          <Text className="wish__sec-title">{tab === 'mine' ? '我的愿望' : '大家在找'}</Text>
          {tab === 'mine' ? (
            <View
              className="wish__new"
              onClick={() => void Taro.navigateTo({ url: '/pages/wish-publish/index' })}
            >
              {/*
                加号用 `plusLine`（本地补画的那枚线稿加号），不要用 `plus` ——
                后者在图标库里其实是一枚盾形图标，不是加号。
              */}
              <Image className="wish__new-ic" src={ICONS.plusLine} mode="aspectFit" />
              <Text>我要许愿</Text>
            </View>
          ) : (
            <Text className="wish__sec-note">按想要人数排序</Text>
          )}
        </View>

        {/* ---- 二级筛选：我的愿望 = 状态，愿望池 = 8 大分类 ---- */}
        <ScrollView className="wish__subs" scrollX enableFlex>
          <View className="wish__subs-inner">
            {tab === 'mine'
              ? MINE_FILTERS.map((item) => (
                  <View
                    key={item.key}
                    className={`wish__sub${item.key === mineFilter ? ' is-on' : ''}`}
                    onClick={() => setMineFilter(item.key)}
                  >
                    <Text>{item.label}</Text>
                    <Text className="wish__sub-n">{mineCount(item.key)}</Text>
                  </View>
                ))
              : [
                  { key: 'ALL' as const, label: '全部' },
                  ...poolCategories.map((key) => ({ key, label: categoryLabel(key) })),
                ].map((item) => (
                  <View
                    key={item.key}
                    className={`wish__sub${item.key === poolFilter ? ' is-on' : ''}`}
                    onClick={() => setPoolFilter(item.key)}
                  >
                    {item.key === 'ALL' ? null : (
                      <Image
                        className="wish__sub-ic"
                        src={HOME_CATEGORY_ICONS[item.key]}
                        mode="aspectFit"
                      />
                    )}
                    <Text>{item.label}</Text>
                    <Text className="wish__sub-n">{poolCount(item.key)}</Text>
                  </View>
                ))}
          </View>
        </ScrollView>

        {/* ---- 列表 ---- */}
        {tab === 'mine' ? (
          mineList.length === 0 ? (
            <View className="wishempty">
              <View className="wishempty__mk">
                <Image className="wishempty__ic" src={ICONS.starAccent} mode="aspectFit" />
              </View>
              <Text className="wishempty__title">这个筛选下还没有愿望</Text>
              <Text className="wishempty__text">
                换个状态看看，或者直接许一个愿 —— 卖家看到你的需求就会来找你
              </Text>
            </View>
          ) : (
            <View className="wish__list">
              {mineList.map((wish) => {
                const hits = matchedListings(wish.id)
                const clickable = hits.length > 0
                return (
                  <View key={wish.id} className="mw">
                    <View className="mw__top">
                      <View className="mw__main">
                        <Text className="mw__time">{wish.timeLabel}许下</Text>
                        <Text className="mw__kw">{wish.keyword}</Text>
                        <View className="mw__cat">
                          <Image
                            className="mw__cat-ic"
                            src={HOME_CATEGORY_ICONS[wish.category]}
                            mode="aspectFit"
                          />
                          <Text>{`想要「${categoryLabel(wish.category)}」类闲置`}</Text>
                        </View>
                      </View>
                      <Text className={`mw__pill ${STATUS_PILL[wish.status]}`}>
                        {STATUS_TEXT[wish.status]}
                      </Text>
                    </View>

                    <View className="mw__meta">
                      <Text className="mw__budget">
                        预算{' '}
                        <Text className="mw__budget-val">
                          {budgetRange(wish.budgetMinCents, wish.budgetMaxCents)}
                        </Text>
                      </Text>
                      {/*
                        命中数用**实际命中条数**而不是契约的 `matchCount`：
                        mock 的 matchCount 是 fixture 里手写的，与 MATCHES 经阈值过滤后的
                        条数可能对不上（w-011 写 3、阈值 70 下只有 2）。用同一个来源，
                        卡片、命中行、匹配结果页三处的数字才一致。
                      */}
                      <Text
                        className={`mw__hits${clickable ? ' is-hit' : ''}`}
                        onClick={() => {
                          if (!clickable) {
                            void Taro.showToast({
                              title: '还没命中：先调整预算或关键词',
                              icon: 'none',
                            })
                            return
                          }
                          void Taro.navigateTo({ url: `/pages/match/index?wishId=${wish.id}` })
                        }}
                      >
                        {`${hits.length} 件闲置命中${clickable ? ' ›' : ''}`}
                      </Text>
                    </View>

                    {/* 命中商品行：只有还在许愿中、且确实有命中的愿望才展示 */}
                    {wish.status === 'ACTIVE' && hits.length > 0 ? (
                      <View className="mw__truth">
                        <View className="mw__truth-hd">
                          <Image
                            className="mw__truth-ic"
                            src={ICONS.checkAccent}
                            mode="aspectFit"
                          />
                          <Text>{`愿望成真 · 命中 ${hits.length} 件`}</Text>
                        </View>
                        {hits.slice(0, HIT_ROWS).map((view) => (
                          <HitRow key={view.match.id} view={view} />
                        ))}
                      </View>
                    ) : null}

                    <View className="mw__act">
                      <View className="mw__act-lk" onClick={() => goSearch(wish.keyword)}>
                        <Image className="mw__act-ic" src={ICONS.search} mode="aspectFit" />
                        <Text>按关键词搜索</Text>
                        <Text className="mw__act-cnt">{hits.length}</Text>
                      </View>
                      <Text
                        className={`mw__act-off${wish.status === 'ACTIVE' ? '' : ' is-off'}`}
                        onClick={() => {
                          if (wish.status !== 'ACTIVE') return
                          closeWish(wish)
                        }}
                      >
                        {wish.status === 'ACTIVE' ? '关闭愿望' : '已是终态'}
                      </Text>
                    </View>
                  </View>
                )
              })}
            </View>
          )
        ) : poolList.length === 0 ? (
          <View className="wishempty">
            <View className="wishempty__mk">
              <Image className="wishempty__ic" src={ICONS.starAccent} mode="aspectFit" />
            </View>
            <Text className="wishempty__title">这个分类下还没有人求购</Text>
            <Text className="wishempty__text">
              {`同一个关键词有 ${POOL_MIN_COUNT} 位以上同学在求，才会出现在这里`}
            </Text>
          </View>
        ) : (
          <View className="wish__list">
            {poolList.map((item) => (
              <View key={item.keyword} className="pool">
                <View className="pool__top">
                  <View className="pool__main">
                    <Text className="pool__kw">{item.keyword}</Text>
                    <View className="pool__cat">
                      <Image
                        className="pool__cat-ic"
                        src={HOME_CATEGORY_ICONS[item.category]}
                        mode="aspectFit"
                      />
                      <Text>{categoryLabel(item.category)}</Text>
                    </View>
                  </View>
                  <Text className="pool__badge">求购</Text>
                </View>
                <View className="pool__meta">
                  <Text className="pool__budget">
                    常见预算{' '}
                    <Text className="pool__budget-val">{formatYuan(item.medianBudgetCents)}</Text>
                  </Text>
                  <Text className="pool__want">{`${item.wantCount} 人想要`}</Text>
                </View>
              </View>
            ))}
            {/* k-匿名说明：池子只输出聚合数字，永不输出 user_id（稿的 .knote） */}
            <View className="knote">
              <Text className="knote__line">
                {`k-匿名 · HAVING count(DISTINCT user_id) >= ${POOL_MIN_COUNT}`}
              </Text>
              <Text className="knote__line">只输出聚合数字，永不输出 user_id 或任何个人字段</Text>
            </View>
          </View>
        )}
      </View>
    </View>
  )
}
