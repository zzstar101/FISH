import type { ListingCard } from '@fish/contracts/listings/schema'
import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
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
import { toViewRect } from '@/features/visual-search/crop'
import { readVisualShot } from '@/features/visual-search/handoff'
import {
  VISUAL_QUERY_LOCAL_PATH_PARAM,
  VISUAL_QUERY_OBJECT_KEY_PARAM,
} from '@/features/visual-search/link'
import {
  dragSheet,
  type SheetStop,
  settleSheet,
  sheetHeight,
  sheetTranslate,
} from '@/features/visual-search/sheet'
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
 * 识图结果页 —— **整张查询图打底 + 从底部升起的结果面板**（Owner 2026-09-30 按参考图定版）。
 *
 * ```text
 * 全屏：查询图（aspectFill 铺满，带一层暗色压顶保证顶部钮可读）
 * 底部：结果面板（默认升到屏高 62%）
 *        拖面板头部往下 → 收起成一条把手；往上甩 → 重新展开
 *        面板内：查询图缩略图 + 识别结论 + 统计 + 排序胶囊 + 结果瀑布流（内层滚动）
 * ```
 *
 * 与上一版（整页滚动、冰蓝页头）的区别就是这一层：**页面本身不滚动**，滚动发生在面板内部；
 * 查询图恒在背景里，用户随时能看见「我拍的是哪张」。
 *
 * ## 面板为什么用「铺满 + translateY」而不是「改高度」
 *
 * 改高度会让面板内部（两列瀑布流）每帧重新布局，拖动时肉眼可见地掉帧；`translateY` 只走
 * 合成层，且收起/展开都能用 CSS 过渡衔接。几何与手势判据全在
 * `features/visual-search/sheet.ts`（纯逻辑、有单测）。
 *
 * ## 三件稿/参考图里有、契约里没有的东西（都不画）
 *
 * | 参考图里 | 为什么不画 |
 * | --- | --- |
 * | 成交均价 / 热销 / 品牌筛选 | 契约的搜索请求只有 `objectKey`，没有排序与筛选参数 —— 除「综合」外的三档都是**对已返回那一批**（服务端上限 30 条）本地重排，见 `./view.ts` |
 * | 卡片上的「N 人想要」「包邮」 | `ListingCard` 没有这两个字段（`features/listing/adapt.ts` 把 `wants` 置 `null`） |
 * | 「个人闲置」标签 | FISH 没有个人 / 商家之分 |
 *
 * 未登录不分叉：识图**匿名可用**（契约 Q6=B），本页不挂登录守卫，也不请求 `GET /me`。
 */

/** 结果瀑布流列宽（与 `pages/search` 同值同源）：750 − 面板左右各 32 − 列间距 20，再除以 2 */
const COLUMN_WIDTH = 329

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
  /** 查询图本地临时路径：**背景图**就是它（查询图存私有前缀，服务端给不出可渲染 URL） */
  const localPath = useMemo(
    () => routeParam(router.params[VISUAL_QUERY_LOCAL_PATH_PARAM]),
    [router.params],
  )

  /**
   * 共享元素式切换的另一半：入口页拍照时 stash 的**原图 + 取框**。
   *
   * 有它时背景用原图、并在上面画出「这次用的是哪一块」（参考图②）；没有它（搜索页 / 结果页
   * 的「换图」没有相机）就退回用 URL 里的查询图铺底。按 `objectKey` 取（见 `./handoff`），
   * 所以重复渲染拿到同一份、换了图则拿到 `null`。
   */
  const shot = useMemo(() => readVisualShot(objectKey), [objectKey])

  /** `loading` = 识别中；`failed` = 识别失败（文案见 `failedText`）；两者互斥 */
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [failedText, setFailedText] = useState('')
  const [interpretation, setInterpretation] = useState<Parameters<typeof queryCardCopy>[0]>(null)
  const [items, setItems] = useState<ListingCard[]>([])
  const [filter, setFilter] = useState<SearchFilter>('综合')
  const [retaking, setRetaking] = useState(false)

  const nav = useMemo(() => readNavMetrics(), [])
  /**
   * 面板可用的屏高（设备 px）。用 `windowHeight + statusBarHeight`：面板从**屏幕底**升起、
   * 背景图也铺满整屏（含状态栏那一截），所以要按整屏高算比例，而不是可用区高度。
   */
  const viewHeight = useMemo(() => {
    const info = Taro.getWindowInfo()
    return info.windowHeight + (info.statusBarHeight ?? 0)
  }, [])

  /** 面板当前高度（设备 px）与「拖动中」标记；拖动期间 `dragging` 为真（此时不加 CSS 过渡） */
  const [height, setHeight] = useState(() => sheetHeight('open', viewHeight))
  const [dragging, setDragging] = useState(false)
  /** 窗口宽度（设备 px）：背景取框的显示坐标换算要用它 */
  const [viewWidth] = useState(() => Taro.getWindowInfo().windowWidth)
  /**
   * 本次拖动的轨迹：起点、上一次触点、以及「上一次那一刻的高度」。
   *
   * 必须用 ref：`onTouchMove` 一帧可能触发多次，等 state 更新来不及；而松手时的**甩动速度**
   * 要按「整段位移 / 整段耗时」算，所以起点与上一次都得留着。
   */
  const dragRef = useRef<{
    startY: number
    startAt: number
    lastY: number
    lastAt: number
  } | null>(null)
  /** 拖动中的高度也留一份在 ref：松手判定要用**当下**的高度，不能读闭包里的 state */
  const heightRef = useRef(height)

  /** 本页唯一的任务代次：重试会开新任务，迟到的响应据此自我作废 */
  const taskLog = useRef<SearchTaskLog>({ current: 0 })

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
        时客户端日志里必须有 strategyVersion / embeddingModel）。
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
   * 作废在途检索挂在 `onPicked`（取图成功、即将上传那一刻）而**不是**这里：本页在识别中
   * 也允许换图，提前作废会让「用户只是点了取消」把已经发出去的那次检索丢弃，而 `loading`
   * 再没有复位路径 —— 面板会永远停在骨架屏上（`search` 的迟到守卫直接 `return`）。
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
      // 作废过却没跳走（上传失败 / 跳转失败）：重跑一次当前这张图的检索
      if (invalidated && outcome !== 'navigated') void search()
    } finally {
      setRetaking(false)
    }
  }

  /* ------------------------------------------------- 面板手势（触摸 → sheet.ts 的几何） */

  /**
   * 触摸点的 `clientY`。
   *
   * 形参取 `unknown` 再按运行时形状收窄：`View.d.ts` 把触摸回调声明成 `CommonEventFunction`
   * （形参里没有 `touches`），直接声明带 `touches` 的类型会参数不兼容。
   */
  const touchY = (event: unknown): number | null => {
    const touches = (event as { touches?: { clientY?: number }[] } | null)?.touches
    const touch = touches?.[0]
    return touch?.clientY === undefined ? null : touch.clientY
  }

  const onDragStart = (event: unknown) => {
    const y = touchY(event)
    if (y === null) return
    const now = Date.now()
    dragRef.current = { startY: y, startAt: now, lastY: y, lastAt: now }
    setDragging(true)
  }

  const onDragMove = (event: unknown) => {
    const drag = dragRef.current
    if (!drag) return
    const y = touchY(event)
    if (y === null) return
    const next = dragSheet(heightRef.current, y - drag.lastY, viewHeight)
    dragRef.current = { ...drag, lastY: y, lastAt: Date.now() }
    heightRef.current = next
    setHeight(next)
  }

  const onDragEnd = () => {
    const drag = dragRef.current
    dragRef.current = null
    setDragging(false)
    if (!drag) return
    // 甩动速度（px/ms，向下为正）：按**整段**位移与耗时算，不只看最后两帧（末帧常常是停住的一帧）
    const elapsed = Math.max(1, Date.now() - drag.startAt)
    const velocity = (drag.lastY - drag.startY) / elapsed
    const stop: SheetStop = settleSheet(heightRef.current, velocity, viewHeight)
    const settled = sheetHeight(stop, viewHeight)
    heightRef.current = settled
    setHeight(settled)
  }

  /** 点把手：在两个停靠位之间切换（收起态点一下能拉回来） */
  const toggleSheet = () => {
    const open = sheetHeight('open', viewHeight)
    const stop: SheetStop = heightRef.current >= open - 1 ? 'closed' : 'open'
    const settled = sheetHeight(stop, viewHeight)
    heightRef.current = settled
    setHeight(settled)
  }

  /**
   * 查询图卡里的识别结论在**识别失败时也要有话说**（参考图的失败态同样有这一行），
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

  /** 统计位：识别中 / 失败 / 没带图时给 `—`，绝不写成「0 件」 */
  const statsPending = loading || failed || missingQuery
  const priceRange = useMemo(() => {
    if (stats.priceMinCents === null || stats.priceMaxCents === null) return null
    if (stats.priceMinCents === stats.priceMaxCents) return `¥${formatAmount(stats.priceMinCents)}`
    return `¥${formatAmount(stats.priceMinCents)}–¥${formatAmount(stats.priceMaxCents)}`
  }, [stats])

  /** 面板收起时那句提示：告诉用户这里还有东西，以及怎么拉起来 */
  const collapsedHint = statsPending
    ? '上滑查看结果'
    : items.length === 0
      ? '没有找到同款，上滑看看'
      : `上滑查看 ${stats.count} 件同款`

  const open = sheetHeight('open', viewHeight)

  /**
   * 背景图上那个「这次用的是哪一块」的取框（显示坐标）。
   *
   * 交接来的取框是**图片像素**，这里用 `toViewRect` 换回当前显示区坐标 —— 入口页与结果页的
   * 显示区尺寸可能不同（状态栏 / 安全区），所以要用图片像素做中转，不能直接把入口页的
   * 显示坐标搬过来。没有交接（搜索页进来的）就没有这个框。
   */
  const cropFrame = useMemo(() => {
    if (!shot) return null
    return toViewRect(shot.crop, { width: viewWidth, height: viewHeight }, shot)
  }, [shot, viewWidth, viewHeight])

  return (
    <View className="vres">
      {/* ---------------- 全屏查询图（本页的「底」，共享元素式切换的另一半） ---------------- */}
      <View className="vres__stage">
        {shot ? (
          <>
            <Image className="vres__photo" src={shot.path} mode="aspectFill" />
            {/* 这次取框的那一块：原图变暗、框内保持原亮度（参考图②的「整张照片 + 框住主体」） */}
            {cropFrame ? (
              <View
                className="vres__frame"
                style={{
                  left: `${cropFrame.x}px`,
                  top: `${cropFrame.y}px`,
                  width: `${cropFrame.w}px`,
                  height: `${cropFrame.h}px`,
                }}
              />
            ) : null}
          </>
        ) : localPath ? (
          <Image className="vres__photo" src={localPath} mode="aspectFill" />
        ) : (
          // 两条路都拿不到图（从别处带参数进页）：占位而不是裂图，检索本身不受影响
          <View className="vres__photo-ph">
            <Text className="vres__photo-ph-text">查询图</Text>
          </View>
        )}
      </View>

      {/* ---------------- 顶部：返回 + 标题（对齐右侧微信原生胶囊的中线） ---------------- */}
      <View
        className="vres__back"
        style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
        onClick={() => void Taro.navigateBack()}
      >
        <View className="vres__back-chevron" />
      </View>
      <Text
        className="vres__title"
        style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
      >
        识图结果
      </Text>

      {/* ---------------- 底部结果面板 ---------------- */}
      <View
        className={`vres__sheet${dragging ? ' is-dragging' : ''}`}
        style={{
          height: `${open}px`,
          transform: `translateY(${sheetTranslate(height, viewHeight)}px)`,
        }}
      >
        {/* 把手区：整套拖动都挂在这一块（下面是滚动列表，不能抢手势） */}
        <View
          className="vres__grabwrap"
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
          onTouchCancel={onDragEnd}
          onClick={toggleSheet}
        >
          <View className="vres__grab" />
          {/* 收起态：只露把手 + 一句提示（点击/上滑都能把面板拉回来） */}
          {height <= sheetHeight('closed', viewHeight) + 1 ? (
            <Text className="vres__hint">{collapsedHint}</Text>
          ) : null}
        </View>

        {height > sheetHeight('closed', viewHeight) + 1 ? (
          <>
            {/* ---- 查询图 + 识别结论 + 重拍 ---- */}
            <View className="vres__qhead">
              <View className="vres__qthumb">
                {localPath ? (
                  <Image className="vres__qthumb-img" src={localPath} mode="aspectFill" />
                ) : (
                  <Text className="vres__qthumb-ph">QUERY</Text>
                )}
              </View>
              <View className="vres__qmain">
                <View className="vres__qtitle">
                  {cardCopy.category ? (
                    <Text className="vres__qcat">{cardCopy.category}</Text>
                  ) : null}
                  <Text className="vres__qname">{cardCopy.title}</Text>
                </View>
                {cardCopy.subtitle ? <Text className="vres__qsub">{cardCopy.subtitle}</Text> : null}
              </View>
              {missingQuery ? null : (
                // 命中区补偿挂在包裹层（88px = 44pt），胶囊保持 64px 的视觉高，见 `index.scss`
                <View className="vres__retake-hit" onClick={retake}>
                  <View className={`vres__retake${retaking ? ' is-busy' : ''}`}>
                    <Image className="vres__retake-ic" src={ICONS.camera} mode="aspectFit" />
                    <Text>{retaking ? '上传中' : '重拍'}</Text>
                  </View>
                </View>
              )}
            </View>

            {/* ---- 统计行：在售同款 | 价格区间 ---- */}
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

            {/* ---- 排序胶囊：只在有结果时可点（空态 / 失败态排序没有对象） ---- */}
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
                        <Image
                          className="vres__fsort-img"
                          src={ICONS.chevronUpMuted}
                          mode="aspectFit"
                        />
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

            {/* ---- 结果区：面板内滚动（页面本身不滚） ---- */}
            <ScrollView className="vres__scroll" scrollY>
              <View className="vres__body">
                {missingQuery ? (
                  <EmptyState
                    title="这次识图没有带上图片"
                    text="从识图页重新拍一张，或在搜索框里点相机图标再来一次。"
                    actionText="回到首页"
                    onAction={() => void Taro.switchTab({ url: '/pages/home/index' })}
                    /* 参考图的图标映射：空态圆盘用「搜索」那枚（默认「分类」语义不对） */
                    icon={ICONS.search}
                  />
                ) : loading ? (
                  /* 骨架屏：两列四张，图片区高度取真实卡片的两档（4:5 / 1:1） */
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
                  /* 失败态：文案取契约，动作是「重试 / 换一张图」 */
                  <View className="vres__err">
                    <View className="vres__err-disc">
                      <Image className="vres__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                    </View>
                    <Text className="vres__err-title">识别没成功</Text>
                    <Text className="vres__err-text">{failedText}</Text>
                    <View className="vres__err-acts">
                      <View className="vres__btn-main" onClick={() => void search()}>
                        <Text>重试</Text>
                      </View>
                      <View
                        className={`vres__btn-ghost${retaking ? ' is-busy' : ''}`}
                        onClick={retake}
                      >
                        <Image className="vres__btn-ic" src={ICONS.camera} mode="aspectFit" />
                        <Text>{retaking ? '上传中…' : '换一张图'}</Text>
                      </View>
                    </View>
                  </View>
                ) : items.length === 0 ? (
                  /* 空态：主「重新拍一张」+ 次「去许愿墙发心愿」 */
                  <View className="vres__empty">
                    <EmptyState
                      title="没有找到相似的在售闲置"
                      text="换一张图或换个角度再拍一次；也可以把需求发到许愿墙，命中后会通知你。"
                      actionText={retaking ? '上传中…' : '重新拍一张'}
                      onAction={() => void retake()}
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
            </ScrollView>
          </>
        ) : null}
      </View>
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

/** 识别中的骨架卡：图片区 + 两行占位条，与真实卡同高同圆角。 */
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
