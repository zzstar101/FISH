import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { loadWishes, WISH_HIT_ROWS, type WishHitList } from '@/features/fetchers'
import type { WishHit } from '@/features/match/adapt'
import { closeWish as closeWishApi } from '@/features/wish/api'
import { consumeWishesDirty } from '@/features/wish/refresh'
import { isApiError } from '@/lib/request'
import {
  categoryLabel,
  formatAmount,
  formatYuan,
  type MockWish,
  type MockWishPoolItem,
  POOL_MIN_COUNT,
  WISH_CATEGORIES,
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
 * 数据走 `features/fetchers.ts` 的 `loadWishes()`（真实接口：
 * `GET /wishes` + `GET /wishes/pool`，命中走 `GET /matches?wishId=`），
 * **不回退 mock**；失败时整页显示错误态与重试入口。关闭愿望走
 * `POST /wishes/:id/close`，成功后重拉列表。
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

/** 预算区间文案：设计稿是「¥30–50」（中间用 en dash，不是 hyphen） */
function budgetRange(minCents: number, maxCents: number): string {
  return `¥${formatAmount(minCents)}–${formatAmount(maxCents)}`
}

/** 命中行的发布时间：稿是「2 小时前发布」，视图只给相对小时数 */
function timeAgo(hoursAgo: number): string {
  if (hoursAgo < 1) return '刚刚'
  if (hoursAgo < 24) return `${Math.round(hoursAgo)} 小时前`
  const days = Math.round(hoursAgo / 24)
  return days <= 1 ? '昨天' : `${days} 天前`
}

/** 命中商品行（`.mw` 卡内嵌的「愿望成真」列表） */
function HitRow({ view }: { view: WishHit }) {
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
  // 愿望列表要登录（GET /wishes、GET /wishes/pool）；Tab 页只能用 navigateTo 跳登录页
  const authStatus = useAuthGuard({ tab: true })
  /** 当前账号：换账号时 effect 要重拉（Tab 页实例跨登录态存活） */
  const { user: authedUser } = useAuth()
  const [tab, setTab] = useState<TabKey>('mine')
  const [mineFilter, setMineFilter] = useState<'ALL' | MockWish['status']>('ALL')
  const [poolFilter, setPoolFilter] = useState<'ALL' | MockWishPoolItem['category']>('ALL')
  const [hotOpen, setHotOpen] = useState(false)
  const [mine, setMine] = useState<MockWish[]>([])
  const [pool, setPool] = useState<MockWishPoolItem[]>([])
  /** 每条 ACTIVE 愿望的命中（key = wishId），与卡片上的「N 件命中」同源 */
  const [hits, setHits] = useState<Record<string, WishHitList>>({})
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  /**
   * 取数：我的愿望 + 愿望池 + 每条 ACTIVE 愿望的命中。
   *
   * 自增序号用来丢弃过期响应：连点重试、或从发布页返回时上一轮还在飞，
   * 先发的请求可能后到，不能让它把新数据覆盖回去。
   * 关闭愿望的连点用 `closingRef` 挡（页面没有「关闭中」的展示位，不需要重渲染）。
   *
   * `silent` = 静默刷新：切 Tab / 从二级页返回时保留屏上数据，不要闪一下「正在加载…」。
   */
  const loadSeq = useRef(0)
  const closingRef = useRef(false)
  const load = useCallback(async (silent = false) => {
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    if (!silent) setState('loading')
    const result = await loadWishes()
    if (loadSeq.current !== seq) return
    if (result.status === 'failed') {
      setState('failed')
      return
    }
    setMine(result.mine)
    setPool(result.pool)
    setHits(result.hits)
    setState('ready')
  }, [])

  /**
   * 登录态就绪后取数；把 `authedUser` 放进判据与依赖，换账号时也重拉。
   * 返回本页（发布成功 / 从匹配结果页回来）由 `useDidShow` 兜住 ——
   * Tab 页被返回时不会重新挂载，只重新显示。
   * 首次显示由这个 effect 负责；`useDidShow` 只在**有写操作**（发布页置的脏标记）时
   * 静默重拉 —— 无条件重拉会让每次切 Tab 都发 `2 + N` 个请求，见 `features/wish/refresh.ts`。
   */
  const loadedRef = useRef(false)
  useEffect(() => {
    if (authStatus !== 'authed' || !authedUser) return
    loadedRef.current = true
    void load()
  }, [authStatus, authedUser, load])
  useDidShow(() => {
    if (!loadedRef.current) return
    if (!consumeWishesDirty()) return
    void load(true)
  })

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

  const closeWish = async (wish: MockWish) => {
    if (wish.status !== 'ACTIVE' || closingRef.current) return
    closingRef.current = true
    try {
      await closeWishApi(wish.id)
      void Taro.showToast({ title: '已关闭这条愿望', icon: 'none' })
      // 静默重拉：状态胶囊由服务端结果决定，不闪加载态
      await load(true)
    } catch (error) {
      // 服务端给的是可读中文（不存在 / 无权 / 已终态冲突），原样透出
      void Taro.showToast({
        title: isApiError(error) ? error.message : '关闭失败，请重试',
        icon: 'none',
      })
    } finally {
      closingRef.current = false
    }
  }

  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

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
        {state === 'loading' ? (
          <View className="wishempty">
            <Text className="wishempty__title">正在加载…</Text>
            <Text className="wishempty__text">正在取「我的愿望」与「愿望池」</Text>
          </View>
        ) : state === 'failed' ? (
          <LoadError title="愿望加载失败" text="检查网络后重试" onRetry={() => void load()} />
        ) : (
          <>
            {/* ---- 热门求购：白卡 + 顶部渐变条 + 两列 + 热度条 ---- */}
            <View className="hot">
              <View className="hot__hd">
                <Text className="hot__title">热门求购</Text>
                {/*
              「近 7 天」曾是设计稿的产品口径，但 `/wishes/pool` 的聚合只看
              `status = ACTIVE`、没有时间窗（`apps/api/src/modules/wishes/store.ts`
              的 `aggregatePool`），契约响应里也没有 `createdAt` 可让前端自己筛。
              接了真接口之后池子里会出现任意时间的愿望，继续写「近 7 天」就是假话，
              所以这里改成不带时间窗的说法（与愿望池 tab 的「按想要人数排序」同口径）。
            */}
                <Text className="hot__note">按想要人数</Text>
              </View>
              <View className="hot__grid">
                {hotList.map((item, index) => (
                  <View
                    // 同一关键词可以在两个分类下各成一条（后端就是 `GROUP BY keyword, category`），
                    // 只用 keyword 当 key 会撞车
                    key={`${item.keyword}\0${item.category}`}
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
                  {/*
                    不能说「展示全部」：`GET /wishes/pool` 服务端 `LIMIT 50`
                    （`apps/api/src/modules/wishes/service.ts` 的 `POOL_LIMIT`），而契约响应
                    只有 `items`、没有 `total`，客户端无法知道有没有被截断 —— 只能说「展开我拿到的 N 个」。
                  */}
                  <Text>{hotOpen ? '收起' : `展开 ${pool.length} 个标签`}</Text>
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
                    const hitList = hits[wish.id]
                    /**
                     * 命中数优先用 `/matches` 的 `total`（与匹配结果页同一口径：阈值过滤 +
                     * 排除下架/超预算），拿不到（终态愿望不拉、或单条请求失败）才退回契约的
                     * `matchCount`。两者可能不同：`matchCount` 数的是库里的行数，`/matches`
                     * 另有阈值与商品状态过滤，且**终态愿望的 /matches 恒为空**。
                     */
                    const hitCount = hitList?.total ?? wish.matchCount
                    /**
                     * 只有「许愿中 + 命中列表确实取到了」才给可点的入口：
                     * - 终态愿望的 `/matches` 恒为空（服务端只返回 ACTIVE 愿望的匹配），
                     *   点进去会看到「已结束 / 0 件」，与卡片的数字对不上 —— 不给死链接；
                     * - `/matches` 取失败时 `hitCount` 退回了未过滤的 `matchCount`，
                     *   同样不该把人送到一个数字可能不同的页面。
                     */
                    const hitLinkable = wish.status === 'ACTIVE' && hitList !== undefined
                    const hitChevron = hitLinkable && hitCount > 0
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
                        计数与下面的命中行都来自 `GET /matches?wishId=`（服务端已按
                        `score >= MATCH_SCORE_THRESHOLD` 过滤并排除下架/超预算商品），
                        所以**取到列表的许愿中愿望**在卡片、命中行、匹配结果页三处数字一致。
                        终态愿望不拉命中（`/matches` 对非 ACTIVE 愿望恒为空），此时显示契约的
                        `matchCount` —— 那是「历史上命中过多少条」的计数，不给跳转入口。
                      */}
                          <Text
                            className={`mw__hits${hitChevron ? ' is-hit' : ''}`}
                            onClick={() => {
                              if (!hitLinkable) return
                              if (hitCount === 0) {
                                void Taro.showToast({
                                  title: '还没命中：先调整预算或关键词',
                                  icon: 'none',
                                })
                                return
                              }
                              void Taro.navigateTo({ url: `/pages/match/index?wishId=${wish.id}` })
                            }}
                          >
                            {`${hitCount} 件闲置命中${hitChevron ? ' ›' : ''}`}
                          </Text>
                        </View>

                        {/* 命中商品行：只有还在许愿中、且确实有命中的愿望才展示 */}
                        {wish.status === 'ACTIVE' && hitList && hitList.items.length > 0 ? (
                          <View className="mw__truth">
                            <View className="mw__truth-hd">
                              <Image
                                className="mw__truth-ic"
                                src={ICONS.checkAccent}
                                mode="aspectFit"
                              />
                              <Text>{`愿望成真 · 命中 ${hitCount} 件`}</Text>
                            </View>
                            {hitList.items.slice(0, WISH_HIT_ROWS).map((view) => (
                              <HitRow key={view.match.id} view={view} />
                            ))}
                          </View>
                        ) : null}

                        <View className="mw__act">
                          <View className="mw__act-lk" onClick={() => goSearch(wish.keyword)}>
                            <Image className="mw__act-ic" src={ICONS.search} mode="aspectFit" />
                            <Text>按关键词搜索</Text>
                            <Text className="mw__act-cnt">{hitCount}</Text>
                          </View>
                          <Text
                            className={`mw__act-off${wish.status === 'ACTIVE' ? '' : ' is-off'}`}
                            onClick={() => {
                              if (wish.status !== 'ACTIVE') return
                              void closeWish(wish)
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
                  <View key={`${item.keyword}\0${item.category}`} className="pool">
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
                        <Text className="pool__budget-val">
                          {formatYuan(item.medianBudgetCents)}
                        </Text>
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
                  <Text className="knote__line">
                    只输出聚合数字，永不输出 user_id 或任何个人字段
                  </Text>
                </View>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  )
}
