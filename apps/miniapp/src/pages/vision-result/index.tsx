import type { ListingCard } from '@fish/contracts/listings/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useLoad, usePageScroll, useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import ProductCard from '@/components/product-card'
import { toMockListing } from '@/features/listing/adapt'
import {
  beginSearchTask,
  invalidateSearchTasks,
  isSearchTaskCurrent,
  type SearchTaskLog,
} from '@/features/listing/search-task'
import { searchByVisualQuery, visualSearchErrorMessage } from '@/features/visual-search/api'
import {
  VISUAL_QUERY_LOCAL_PATH_PARAM,
  VISUAL_QUERY_OBJECT_KEY_PARAM,
} from '@/features/visual-search/link'
import { startVisualSearch } from '@/features/visual-search/start'
import { formatAmount } from '@/lib/money'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import { routeParam } from '@/lib/route-param'
import { searchFilters } from '@/mock/api'
import type { MockListing, SearchFilter } from '@/mock/types'
import { queryCardCopy, resultStats, sortResults } from './view'
import './index.scss'

/**
 * 识图结果页（设计稿 `D:\Downloads\2改\设计稿_V1-vision-result.html`）。
 *
 * 上游是识图入口页（`pages/scan-vision`）与搜索页顶栏的识图按钮 —— 两者都只负责
 * 取图 + 上传，拿到 `objectKey` 后带参数 `navigateTo` 到这里
 * （`features/visual-search/link.ts`），检索与结果渲染全在本页：
 *
 * ```text
 * useLoad 读 visualObjectKey → POST /visual-search → items: ListingCard[]
 *   → 查询图卡（识别结论）+ 两段统计 + 排序胶囊 + 两列瀑布流
 * ```
 *
 * ## 页面结构（稿的区块清单）
 *
 * 冰蓝页头（`--grad-page` + 下缘 32pt 圆角）里放**顶栏 + 查询图卡 + 统计行**，三块一起
 * 随内容滚走；下面接吸顶排序条与结果区。所以这里**不用** `components/top-bar`：那个组件
 * 是 `position: fixed`（一级页要的是「钉住」），而稿要求页头整块滚走。
 *
 * ## 三件稿里有、契约里没有的东西（都不画）
 *
 * | 稿里 | 为什么不画 |
 * | --- | --- |
 * | 「近期成交均价」 | 契约只有 `items: ListingCard[]`，没有成交价聚合；按稿的替代方案用**价格区间**（由 items 直接算） |
 * | 卡片上的「N 人想要」「包邮」 | `ListingCard` 没有这两个字段（`features/listing/adapt.ts` 把 `wants` 置 `null`，页面据此不渲染） |
 * | 「个人闲置」标签 | FISH 没有个人 / 商家之分 |
 *
 * ## 排序是客户端做的
 *
 * 契约的搜索请求只有 `objectKey`（服务端按混合权重排好序返回），没有排序参数 ——
 * 所以除「综合」（= 服务端顺序）外，三档都是对已返回那一批（服务端上限 30 条）重排，
 * 不改召回范围。见 `./view.ts` 的 `sortResults`。
 *
 * ## 状态覆盖（稿的 01–05）
 *
 * | 屏 | 状态 | 本页做法 |
 * | --- | --- | --- |
 * | 01 | 结果 · 默认 | 查询图卡 + 统计 + 瀑布流 |
 * | 02 | 识别中 | 统计位给 `—`（不写 0 件）+ 两列骨架屏 |
 * | 03 | 空态 | 空态（主：重新拍一张 / 次：去许愿墙） |
 * | 04 | 失败态 | 错误块（重试 / 换一张图），文案取契约 |
 * | 05 | `interpretation === null` | 查询图卡退化成「只看图找同款」（`queryCardCopy`） |
 *
 * 未登录不分叉：识图**匿名可用**（契约 Q6=B），本页不挂登录守卫，也不请求 `GET /me`。
 */

/** 结果瀑布流列宽（与 `pages/search` 同值同源）：750 − 左右各 40 − 列间距 24，再除以 2 */
const COLUMN_WIDTH = 337

/** 设计稿的错落比例 → 图片区高度（与 `pages/search` 同一张表，复用 `adapt.ts` 派生的 ratio） */
const RATIO_HEIGHT: Record<MockListing['ratio'], number> = {
  '1x1': COLUMN_WIDTH,
  '4x5': Math.round((COLUMN_WIDTH * 5) / 4),
  '5x6': Math.round((COLUMN_WIDTH * 6) / 5),
  '3x4': Math.round((COLUMN_WIDTH * 4) / 3),
  '4x3': Math.round((COLUMN_WIDTH * 3) / 4),
}

/** 骨架屏的图片区高度：与真实卡片同一档（1:1 / 4:5），不另造一套比例 */
const SKELETON_HEIGHTS = [RATIO_HEIGHT['4x5'], RATIO_HEIGHT['1x1']] as const

export default function VisionResult() {
  const router = useRouter<Record<string, string | undefined>>()
  /** 查询图对象键：进页时定下，之后不变（换图是重新上传后整页替换） */
  const objectKey = useMemo(
    () => routeParam(router.params[VISUAL_QUERY_OBJECT_KEY_PARAM]),
    [router.params],
  )
  /** 查询图本地临时路径：给查询图卡当缩略图（查询图存私有前缀，服务端给不出可渲染 URL） */
  const localPath = useMemo(
    () => routeParam(router.params[VISUAL_QUERY_LOCAL_PATH_PARAM]),
    [router.params],
  )

  /** `loading` = 识别中；`failed` = 识别失败（文案见 `failedText`）；两者互斥 */
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [failedText, setFailedText] = useState('')
  const [interpretation, setInterpretation] = useState<Parameters<typeof queryCardCopy>[0]>(null)
  const [items, setItems] = useState<ListingCard[]>([])
  const [filter, setFilter] = useState<SearchFilter>('综合')
  const [retaking, setRetaking] = useState(false)
  const [showTop, setShowTop] = useState(false)

  /** 本页唯一的任务代次：重试会开新任务，迟到的响应据此自我作废 */
  const taskLog = useRef<SearchTaskLog>({ current: 0 })

  const nav = useMemo(() => readNavMetrics(), [])

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /** 没有查询图（参数丢了 / 被手改 URL）：不静默转普通搜索，直接说清楚 */
  const missingQuery = objectKey === ''

  /** 发起一次检索（进页一次、失败后重试一次）。 */
  const search = async (): Promise<void> => {
    const startedAt = beginSearchTask(taskLog.current)
    setLoading(true)
    setFailed(false)
    setFailedText('')
    setItems([])
    try {
      const result = await searchByVisualQuery(objectKey)
      // 迟到的响应不得写回：页面已重开一次检索 / 已卸载
      if (!isSearchTaskCurrent(taskLog.current, startedAt)) return
      /*
        契约要求客户端**记录**这三个值（`packages/contracts/src/visual/schema.ts` 的
        `VisualSearchResponseSchema`：M6 要求可记录、可回放，排查「为什么昨天的结果不一样」
        时客户端日志里必须有 strategyVersion / embeddingModel）。所以它们不只是内部字段 ——
        debug 档留一条，把「这一次结果是哪一版策略 + 哪个模型算的」钉在日志里。
      */
      console.debug(
        `[miniapp] 识图完成 queryId=${result.queryId} strategy=${result.strategyVersion} model=${result.embeddingModel}`,
      )
      setInterpretation(result.interpretation)
      setItems(result.items)
      setLoading(false)
    } catch (error) {
      if (!isSearchTaskCurrent(taskLog.current, startedAt)) return
      setLoading(false)
      setFailed(true)
      setFailedText(visualSearchErrorMessage(error))
      // 契约错误码留在日志里：排查「这个用户为什么看到失败」时光有文案不够
      if (isApiError(error)) console.warn('[miniapp] 识图搜索失败', error.code, error.message)
    }
  }

  useLoad(() => {
    if (missingQuery) {
      setLoading(false)
      return
    }
    void search()
  })

  /** 卸载：作废在途检索，避免迟到的响应写回已销毁页面 */
  useEffect(() => {
    return () => invalidateSearchTasks(taskLog.current)
  }, [])

  /**
   * 换一张图 / 重拍：走与入口页同一条链（弹来源 → 上传 → 跳结果页），
   * 但用 `redirectTo` **替换当前页** —— 否则每换一次图都在页面栈里多压一层结果页。
   *
   * 作废在途检索挂在 `onPicked`（取图成功、即将上传那一刻）而**不是**这里：本页在
   * `loading` 期间也渲染「重拍」（用户就是想在识别中换图），提前作废会让「用户只是点了
   * 取消」把已经发出去的那次检索丢弃，而 `loading` 再没有复位路径 —— 页面会永远停在
   * 骨架屏上（`search` 的迟到守卫直接 `return`，`setLoading(false)` 被跳过）。
   */
  const retake = async () => {
    if (retaking) return
    setRetaking(true)
    /** `onPicked` 是否真的跑过（跑过 = 在途检索已被作废，页面自己得把 loading 收回来） */
    let invalidated = false
    try {
      const outcome = await startVisualSearch({
        replace: true,
        onPicked: () => {
          invalidated = true
          invalidateSearchTasks(taskLog.current)
        },
      })
      // 作废过却没跳走（上传失败 / 跳转失败）：重跑一次当前这张图的检索。
      // 不重跑的话旧响应已被丢弃、`loading` 无人复位，页面会停在骨架屏上。
      if (invalidated && outcome !== 'navigated') void search()
    } finally {
      setRetaking(false)
    }
  }

  /**
   * 查询图卡里的识别结论在**识别失败时也要有话说**（稿 04 的查询图卡是「这张图没搜成」），
   * 所以文案由状态决定，而不是只在成功时取 `interpretation`。
   */
  const cardCopy = useMemo(() => {
    if (loading) {
      return { category: null, title: '正在识别这张图…', subtitle: '按图片相似度比对在售闲置' }
    }
    if (failed) return { category: null, title: '这张图没搜成', subtitle: failedText }
    return queryCardCopy(interpretation)
  }, [loading, failed, failedText, interpretation])

  const stats = useMemo(() => resultStats(items), [items])
  const [left, right] = useMemo(() => {
    const ordered = sortResults(items, filter)
    const leftCol: ListingCard[] = []
    const rightCol: ListingCard[] = []
    ordered.forEach((item, index) => {
      if (index % 2 === 0) leftCol.push(item)
      else rightCol.push(item)
    })
    return [leftCol, rightCol]
  }, [items, filter])

  /** 统计位：识别中 / 失败 / 没带图时给 `—`，绝不写成「0 件」（稿 02 的取舍） */
  const statsPending = loading || failed || missingQuery
  const priceRange = useMemo(() => {
    if (stats.priceMinCents === null || stats.priceMaxCents === null) return null
    if (stats.priceMinCents === stats.priceMaxCents) return `¥${formatAmount(stats.priceMinCents)}`
    return `¥${formatAmount(stats.priceMinCents)}–¥${formatAmount(stats.priceMaxCents)}`
  }, [stats])

  return (
    <View className="vres">
      {/* ---------------- 页头：顶栏 + 查询图卡 + 统计行（随内容滚走） ---------------- */}
      <View
        className="vres__head"
        // 状态栏占位走页头的 padding-top（设备 px，内联下发不参与 rpx 缩放）：
        // 这样「返回钮 + 居中标题」那一行本身就是整条栏的宽度，标题居中即屏幕居中
        style={{ paddingTop: `${nav.statusBarHeight}px` }}
      >
        <View className="vres__topbar">
          <View className="vres__back" onClick={() => void Taro.navigateBack()}>
            <View className="vres__back-chevron" />
          </View>
          <Text className="vres__title">识图结果</Text>
        </View>

        {/* ---- 查询图卡：查询图缩略图 + 识别结论 + 重拍 ---- */}
        <View className="vres__qcard">
          <View className="vres__qthumb">
            {localPath ? (
              <Image className="vres__qthumb-img" src={localPath} mode="aspectFill" />
            ) : (
              // 拿不到本地路径（从别处带参数进页）：占位而不是裂图，检索本身不受影响
              <Text className="vres__qthumb-ph">QUERY</Text>
            )}
          </View>
          <View className="vres__qmain">
            <View className="vres__qtitle">
              {cardCopy.category ? <Text className="vres__qcat">{cardCopy.category}</Text> : null}
              <Text className="vres__qname">{cardCopy.title}</Text>
            </View>
            {cardCopy.subtitle ? <Text className="vres__qsub">{cardCopy.subtitle}</Text> : null}
          </View>
          {missingQuery ? null : (
            // 命中区补偿挂在包裹层（88px = 44pt），胶囊保持 64px 的视觉高，见 `index.scss`
            <View className="vres__qretake-hit" onClick={retake}>
              <View className={`vres__qretake${retaking ? ' is-busy' : ''}`}>
                <Image className="vres__qretake-ic" src={ICONS.camera} mode="aspectFit" />
                <Text>{retaking ? '上传中' : '重拍'}</Text>
              </View>
            </View>
          )}
        </View>

        {/* ---- 两段统计行：在售同款 | 价格区间（对位稿的「在售同款 | 成交均价」） ---- */}
        <View className="vres__stats">
          <View className="vres__stat">
            <Text className="vres__stat-k">在售同款</Text>
            {statsPending ? (
              <Text className="vres__stat-dash">—</Text>
            ) : (
              <Text className="vres__stat-v num">
                {stats.count}
                <Text className="vres__stat-em">件</Text>
              </Text>
            )}
          </View>
          <View className="vres__stat-sep" />
          <View className="vres__stat">
            <Text className="vres__stat-k">价格区间</Text>
            {priceRange === null ? (
              <Text className="vres__stat-dash">—</Text>
            ) : (
              <Text className="vres__stat-v vres__stat-v--price num">{priceRange}</Text>
            )}
          </View>
        </View>
      </View>

      {/*
        排序胶囊（稿 `.filterbar`，吸顶玻璃）。用页面内的 `position: sticky`：本页根节点
        **不能写 overflow**（写了页面自身就成了滚动容器，sticky 会退化成普通元素，
        见 `pages/wish/index.scss` 的实测记录），所以根节点只给 `min-height`。

        只在有结果时渲染：空态 / 失败态下排序没有对象（稿 03 / 04 也没有这一条）。
        稿 02（识别中）**画了**这一条，但本页在加载态不渲染 —— 此刻排序改的是空数组，
        给一排能按但按不出东西的胶囊不如不给；这条取舍与稿的差异记在这里。
      */}
      {!statsPending && items.length > 0 ? (
        <View className="vres__filters">
          {searchFilters.map((item) => (
            <View
              key={item}
              className={`vres__fchip${item === filter ? ' is-on' : ''}`}
              onClick={() => setFilter(item)}
            >
              <Text>{item}</Text>
              {item === '价格' ? (
                <View className="vres__fsort">
                  <Image className="vres__fsort-img" src={ICONS.chevronUpMuted} mode="aspectFit" />
                  <Image
                    className="vres__fsort-img"
                    src={ICONS.chevronDownMuted}
                    mode="aspectFit"
                  />
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      <View className="vres__body">
        {missingQuery ? (
          <EmptyState
            title="这次识图没有带上图片"
            text="从识图页重新拍一张，或在搜索框里点相机图标再来一次。"
            actionText="回到首页"
            onAction={() => void Taro.switchTab({ url: '/pages/home/index' })}
            /* 稿 §2 的图标映射：空态圆盘用「搜索」那枚（默认的「分类」图标语义不对） */
            icon={ICONS.search}
          />
        ) : loading ? (
          /* 骨架屏（稿 02）：两列四张，图片区高度取真实卡片的两档（4:5 / 1:1） */
          <View className="waterfall">
            <View className="waterfall__col">
              <SkeletonCard height={SKELETON_HEIGHTS[0]} />
              <SkeletonCard height={SKELETON_HEIGHTS[1]} />
            </View>
            <View className="waterfall__col">
              <SkeletonCard height={SKELETON_HEIGHTS[1]} />
              <SkeletonCard height={SKELETON_HEIGHTS[0]} />
            </View>
          </View>
        ) : failed ? (
          /* 失败态（稿 04）：文案取契约（`visualSearchErrorMessage`），动作是「重试 / 换一张图」 */ <View className="vres__err">
            <View className="vres__err-disc">
              <Image className="vres__err-ic" src={ICONS.warnInk} mode="aspectFit" />
            </View>
            <Text className="vres__err-title">识别没成功</Text>
            <Text className="vres__err-text">{failedText}</Text>
            <View className="vres__err-acts">
              <View className="vres__btn-main" onClick={() => void search()}>
                <Text>重试</Text>
              </View>
              <View className={`vres__btn-ghost${retaking ? ' is-busy' : ''}`} onClick={retake}>
                <Image className="vres__btn-ic" src={ICONS.camera} mode="aspectFit" />
                <Text>{retaking ? '上传中…' : '换一张图'}</Text>
              </View>
            </View>
          </View>
        ) : items.length === 0 ? (
          /* 空态（稿 03）：主「重新拍一张」+ 次「去许愿墙发心愿」 */
          <View className="vres__empty">
            <EmptyState
              title="没有找到相似的在售闲置"
              text="换一张图或换个角度再拍一次；也可以把需求发到许愿墙，命中后会通知你。"
              actionText={retaking ? '上传中…' : '重新拍一张'}
              onAction={() => void retake()}
              /* 稿 §2 的图标映射：空态圆盘用「搜索」那枚（默认的「分类」图标语义不对） */
              icon={ICONS.search}
            />
            <View className="vres__btn-ghost vres__btn-ghost--narrow" onClick={goWish}>
              <Image className="vres__btn-ic" src={ICONS.tabWish} mode="aspectFit" />
              <Text>去许愿墙发心愿</Text>
            </View>
          </View>
        ) : (
          <View className="waterfall">
            <View className="waterfall__col">
              {left.map((item) => (
                <ResultCard key={item.id} card={item} />
              ))}
            </View>
            <View className="waterfall__col">
              {right.map((item) => (
                <ResultCard key={item.id} card={item} />
              ))}
            </View>
          </View>
        )}
      </View>

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )

  function goWish(): void {
    void Taro.switchTab({ url: '/pages/wish/index' })
  }
}

/**
 * 一张结果卡。
 *
 * `seller` 恒传 `null`：契约的 `ListingCard` **没有卖家字段**（`ListingCardSchema`），
 * 真实数据下列表卡拿不到卖家 —— `ProductCard` 会整行不渲染，而不是编一个卖家出来
 * （`features/listing/adapt.ts` 的铁律 2）。收藏 / 想要计数同理，由 `toMockListing` 置 `null`。
 */
function ResultCard({ card }: { card: ListingCard }) {
  const listing = useMemo(() => toMockListing(card), [card])
  return <ProductCard listing={listing} seller={null} imageHeight={RATIO_HEIGHT[listing.ratio]} />
}

/** 识别中的骨架卡（稿 `.skel`）：图片区 + 两行占位条，与真实卡同高同圆角。 */
function SkeletonCard({ height }: { height: number }) {
  return (
    <View className="vres__skel">
      <View className="vres__skel-ph" style={{ height: `${height}rpx` }} />
      <View className="vres__skel-body">
        <View className="vres__skel-bar" />
        <View className="vres__skel-bar vres__skel-bar--short" />
      </View>
    </View>
  )
}
