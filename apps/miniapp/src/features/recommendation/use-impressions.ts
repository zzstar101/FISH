/**
 * 首页瀑布流的曝光 / 快速划过判定（Issue #323 R1 §3.4）。
 *
 * **为什么交给 `createIntersectionObserver` 而不是自己按 scrollTop 算**：瀑布流每张卡的
 * 绝对位置要等图片把高度撑开才知道，自己算会在图片加载期间给出错的可见比例；
 * 观察器由宿主在真实布局完成后回调，而且阈值能直接取契约里的那一份。
 *
 * 观察目标是商品卡根节点（`.pcard`，见 `components/product-card/index.tsx`），
 * `observeAll: true` 让一个观察器盯住整屏卡片，不为每张卡各建一个观察器。
 */
import { RECOMMENDATION_THRESHOLDS } from '@fish/contracts/recommendation/schema'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef } from 'react'
import { trackRecommendationEvent } from './track'

export type FeedTrackingContext = {
  /** 本次推荐请求 id；退 mock（开发/预览）或分类列表没有它 → 曝光类事件不发（契约要求必带） */
  requestId: string | null
  /** 公开 id → 本次推荐请求内的全局 position（**过滤隐藏名单之前**的原始序号） */
  positions: Map<string, number>
}

/** 商品卡根节点的类名与 id 前缀：观察器靠它们把回调对回具体的商品 */
const CARD_SELECTOR = '.pcard'
const CARD_ID_PREFIX = 'pcard-'

type CardObserver = ReturnType<typeof Taro.createIntersectionObserver>

/**
 * 观察器回调的**运行时**形状。
 *
 * Taro 的 `IntersectionObserver.ObserveCallbackResult` 里没有 `id` / `dataset`，
 * 但微信文档里有（`observeAll` 模式下就是靠它们区分回调来自哪个节点）。
 * 所以这里按实际字段自行声明，而不是用 `any` 或非空断言绕过去。
 */
type ObserveResult = {
  intersectionRatio?: number
  id?: string
  dataset?: Record<string, unknown>
}

/** 观察器工厂的签名；宿主端（weapp / H5）对 component 参数的要求不一致，按 unknown 透传 */
type ObserverFactory = (
  component: unknown,
  options: { thresholds: number[]; observeAll: boolean },
) => CardObserver

function createCardObserver(): CardObserver | null {
  const options = {
    /*
      0 用来接「完全离开视口」的边界。只挂 0.5 时，一帧里从 0.6 直接滑到 0 的节点
      不一定给出回调，可见段就结算不掉 —— 计时器会在卡片已经不可见之后才补发一条曝光。
    */
    thresholds: [0, RECOMMENDATION_THRESHOLDS.impressionMinVisibleRatio],
    observeAll: true,
  }
  const page: unknown = Taro.getCurrentInstance().page

  const taroFactory = Taro.createIntersectionObserver as unknown as ObserverFactory | undefined
  if (typeof taroFactory === 'function') {
    try {
      return taroFactory(page, options)
    } catch {
      /* 有的端不接受 component 参数，下面再试一次不带参数的形态 */
    }
    try {
      return taroFactory(undefined, options)
    } catch {
      /* 继续降级到宿主原生 API */
    }
  }

  const wxHost = (globalThis as { wx?: { createIntersectionObserver?: ObserverFactory } }).wx
  const wxFactory = wxHost?.createIntersectionObserver
  if (typeof wxFactory === 'function') {
    try {
      return wxFactory(page, options)
    } catch {
      return null
    }
  }
  return null
}

/** 同一 requestId 内同一商品的去重键 */
function segmentKey(requestId: string, listingId: string): string {
  return `${requestId}:${listingId}`
}

/** 从回调结果里认出是哪个商品；认不出（比如自定义组件里的事件）就跳过 */
function readListingId(result: ObserveResult): string | null {
  const fromDataset = result.dataset?.listingId
  if (typeof fromDataset === 'string' && fromDataset.length > 0) return fromDataset
  const fromId = result.id
  if (typeof fromId === 'string' && fromId.startsWith(CARD_ID_PREFIX)) {
    return fromId.slice(CARD_ID_PREFIX.length)
  }
  return null
}

/**
 * 结算原因。
 *
 * - `viewport`：卡片真的离开了视口（滑走 / 数据换批），按可见时长判曝光还是快速划过；
 * - `dismissed`：用户明确「不感兴趣」把卡片移除。这是一次**有意**操作，不能因为停留
 *   不足 1s 再补一条 QUICK_SKIP —— 那个事件的含义是「没点开就被划过去了」，与主动隐藏相反。
 */
type SettleReason = 'viewport' | 'dismissed'

type VisibleSegment = {
  listingId: string
  requestId: string
  position: number
  /** 当前这一轮连续可见的计时起点；`paused` 为真时不推进 */
  startedAt: number
  /** 之前几轮连续可见已累计的时长；页面隐藏会把当时那一轮并进来 */
  visibleMs: number
  /** 页面隐藏造成的暂停：暂停期间既不计时，也不参与判定 */
  paused: boolean
  /** 这一段里的最大可见比例（曝光事件要带上它） */
  maxRatio: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * 这一段的**可见**时长。页面隐藏的时间不计入：切走时用户没有在看，
 * 把它算成停留会让「回到小程序」变成一次假曝光。
 */
function visibleDurationOf(segment: VisibleSegment, now = Date.now()): number {
  if (segment.paused) return segment.visibleMs
  return segment.visibleMs + Math.max(0, now - segment.startedAt)
}

/** 发一条曝光；`durationMs` 由调用方给（实时结算与收尾结算的时刻不同） */
function emitImpression(segment: VisibleSegment, durationMs: number): void {
  trackRecommendationEvent({
    listingId: segment.listingId,
    eventType: 'IMPRESSION',
    attribution: { requestId: segment.requestId, position: segment.position },
    metadata: {
      visibleRatio: segment.maxRatio,
      durationMs,
      // R1 的 Feed 没有翻页入口（`nextCursor` 未接），所有曝光都属于第 0 页
      pageIndex: 0,
    },
  })
}

export type FeedImpressions = {
  /** 卡片被点开：快速划过的判定要求「未点开」，所以这个信号必须在导航之前记下 */
  markOpened: (listingId: string) => void
  /**
   * 卡片从列表里消失（隐藏 / 刷新）：就地结算它的可见段，别让计时器事后补发曝光。
   *
   * `reason` 默认 `viewport`；用户明确「不感兴趣」时传 `dismissed`，
   * 那一次结算不会再补 QUICK_SKIP（见 `SettleReason`）。
   */
  settleListing: (listingId: string, reason?: SettleReason) => void
}

export function useFeedImpressions(options: {
  items: { id: string }[]
  /**
   * 上下文 ref。这里用**可变对象**的结构类型而不是 React 的 `RefObject<T>`：
   * 后者的 `current` 是可空的（`T | null`），会把「一定有值」这件事擦掉，
   * 逼得每个使用点都补一次空判断。
   */
  contextRef: { current: FeedTrackingContext }
}): FeedImpressions {
  const { items, contextRef } = options
  /** 正在计时的可见段，键 = `requestId:listingId` */
  const segmentsRef = useRef(new Map<string, VisibleSegment>())
  /*
    曝光与快速划过**各自**只发一次，所以要两本账：
    合成一本的话，先发的 QUICK_SKIP 会把键永久占住，之后这张卡真被看满 1s 也发不出 IMPRESSION
    （用户快速划过又回来看完，正是最该记成曝光的情况）。
  */
  const impressionSettledRef = useRef(new Set<string>())
  const quickSkipSettledRef = useRef(new Set<string>())
  /** 被点开过的键：快速划过的条件是「可见不到阈值且**未点开**」 */
  const openedRef = useRef(new Set<string>())
  /** 页面是否处于隐藏态：隐藏期间不计时（见 `pauseAll` / `resumeAll`） */
  const hiddenRef = useRef(false)

  /**
   * 结算一个可见段：按已可见时长决定发曝光还是快速划过。
   *
   * 收尾结算（数据换批 / 组件卸载 / 卡片被移除）也走这里 —— 用户确实看了那么久，
   * 不能因为「没等到计时器响」就整段丢掉。
   */
  const settle = useCallback((segment: VisibleSegment, reason: SettleReason = 'viewport') => {
    const key = segmentKey(segment.requestId, segment.listingId)
    if (segment.timer !== null) clearTimeout(segment.timer)
    segmentsRef.current.delete(key)
    const durationMs = visibleDurationOf(segment)
    if (durationMs >= RECOMMENDATION_THRESHOLDS.impressionMinDurationMs) {
      if (impressionSettledRef.current.has(key)) return
      impressionSettledRef.current.add(key)
      emitImpression(segment, durationMs)
      return
    }
    // 明确「不感兴趣」不是「划过去」：不发 QUICK_SKIP（曝光在上面已按真实时长判过）
    if (reason === 'dismissed') return
    // 点开过就不算「快速划过」：点进详情说明这张卡被真的看上了，
    // 记成划过会把一次有意的点击说成「不感兴趣」。但也不算已曝光，回到列表再看满阈值照样算。
    if (openedRef.current.has(key)) return
    // 已经曝光过的不再补一条划过（曝光是更强的信号，回头再滑走不推翻它）
    if (impressionSettledRef.current.has(key)) return
    if (durationMs >= RECOMMENDATION_THRESHOLDS.quickSkipMaxDurationMs) return
    if (quickSkipSettledRef.current.has(key)) return
    quickSkipSettledRef.current.add(key)
    trackRecommendationEvent({
      listingId: segment.listingId,
      eventType: 'QUICK_SKIP',
      attribution: { requestId: segment.requestId, position: segment.position },
      metadata: { durationMs },
    })
  }, [])

  /**
   * 给可见段挂上「连续可见满 `impressionMinDurationMs` 就结算」的计时器。
   *
   * 剩余时长按**已可见时长**算，而不是固定 1000ms：页面隐藏会暂停计时，
   * 回来后要接着走完剩下的那点时间，不能从头再计一遍（否则隐藏一次就永久发不出曝光）。
   */
  const armTimer = useCallback(
    (segment: VisibleSegment) => {
      if (segment.timer !== null) clearTimeout(segment.timer)
      const key = segmentKey(segment.requestId, segment.listingId)
      const remaining = Math.max(
        0,
        RECOMMENDATION_THRESHOLDS.impressionMinDurationMs - visibleDurationOf(segment),
      )
      segment.timer = setTimeout(() => {
        if (segmentsRef.current.get(key) !== segment) return
        settle(segment)
      }, remaining)
    },
    [settle],
  )

  const handleObserve = useCallback(
    (raw: unknown) => {
      const result = raw as ObserveResult
      const listingId = readListingId(result)
      if (!listingId) return
      const context = contextRef.current
      const requestId = context.requestId
      /*
        没有 requestId 就没有归因（退 mock 的开发/预览、分类列表）：契约强制曝光类事件
        必带 requestId + position，硬发一条不带归因的会被整条拒收 —— 所以干脆不发。
      */
      if (!requestId) return
      const position = context.positions.get(listingId)
      if (position === undefined) return

      const ratio = result.intersectionRatio ?? 0
      const key = segmentKey(requestId, listingId)
      const existing = segmentsRef.current.get(key)

      if (ratio >= RECOMMENDATION_THRESHOLDS.impressionMinVisibleRatio) {
        if (existing) {
          existing.maxRatio = Math.max(existing.maxRatio, ratio)
          return
        }
        const segment: VisibleSegment = {
          listingId,
          requestId,
          position,
          startedAt: Date.now(),
          visibleMs: 0,
          // 页面隐藏时不会有观察器回调；万一有，新段也先按暂停起，由 resumeAll 接手
          paused: hiddenRef.current,
          maxRatio: ratio,
          timer: null,
        }
        segmentsRef.current.set(key, segment)
        // 计时期间滑走会被 settle 清掉；能响铃就说明「连续可见」满了阈值
        if (!segment.paused) armTimer(segment)
        return
      }

      // 可见比例掉到阈值以下（含 0 = 完全离开视口）：这一段到此为止
      if (existing) settle(existing)
    },
    [contextRef, settle, armTimer],
  )

  useEffect(() => {
    /*
      数据换了一批（切分类 / 下拉刷新 / 重试）：上一批的可见段先就地结算。
      不结算的话它们的计时器会在新列表上屏之后才响，补发一条指向已经不在屏幕上的卡片、
      且归因属于上一次请求的曝光。
    */
    const currentRequestId = contextRef.current.requestId
    for (const segment of [...segmentsRef.current.values()]) {
      if (segment.requestId !== currentRequestId) settle(segment)
    }

    /*
      `observeAll` 只对调用时刻视图层里已存在的节点生效：新上屏的卡片必须重新 observe 才会
      进入观察集合。所以这里显式读一次 `items`，让「卡片集合变了就重建观察器」成为真实依赖，
      而不是只写在注释里的约定（空列表没有可观察的东西，直接跳过）。
    */
    if (items.length === 0) return

    const observer = createCardObserver()
    if (!observer) return
    let cancelled = false
    /*
      等一次 `nextTick` 再观察：观察器按选择器在小程序视图层里找节点，而 `useEffect`
      跑在 React 提交之后、视图层的节点更新还是异步的 —— 立刻 observe 会选中一个空集合，
      表现为「曝光一条都不发」。列表变化时重建观察器，保证新上屏的卡片也被观察到。
    */
    Taro.nextTick(() => {
      if (cancelled) return
      observer.relativeToViewport().observe(CARD_SELECTOR, handleObserve)
    })
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [items, contextRef, handleObserve, settle])

  const markOpened = useCallback(
    (listingId: string) => {
      const requestId = contextRef.current.requestId
      if (!requestId) return
      openedRef.current.add(segmentKey(requestId, listingId))
    },
    [contextRef],
  )

  const settleListing = useCallback(
    (listingId: string, reason: SettleReason = 'viewport') => {
      for (const segment of [...segmentsRef.current.values()]) {
        if (segment.listingId === listingId) settle(segment, reason)
      }
    },
    [settle],
  )

  /**
   * 页面隐藏（切后台 / 跳走）**暂停**所有可见段的计时。
   *
   * 隐藏不是「离开视口」：把每一段就地结算的话，所有不到 1s 的段都会变成 QUICK_SKIP
   * （用户只是切出去接了个电话），而切走的那段时间也不是停留 —— 所以这里既不结算、
   * 也把计时器停掉，回到页面再从剩余时长接着走。
   */
  const pauseAll = useCallback(() => {
    hiddenRef.current = true
    const now = Date.now()
    for (const segment of segmentsRef.current.values()) {
      if (segment.paused) continue
      segment.visibleMs += Math.max(0, now - segment.startedAt)
      segment.paused = true
      if (segment.timer !== null) {
        clearTimeout(segment.timer)
        segment.timer = null
      }
    }
  }, [])

  /** 回到页面：接着走完每一段剩下的可见时长（隐藏的时间已经排除在外） */
  const resumeAll = useCallback(() => {
    hiddenRef.current = false
    for (const segment of segmentsRef.current.values()) {
      if (!segment.paused) continue
      segment.paused = false
      segment.startedAt = Date.now()
      armTimer(segment)
    }
  }, [armTimer])

  useDidHide(pauseAll)
  useDidShow(resumeAll)

  // 组件卸载：把还开着的可见段收尾结算，别把它们留在计时器里
  const settleAll = useCallback(() => {
    for (const segment of [...segmentsRef.current.values()]) settle(segment)
  }, [settle])

  useEffect(() => settleAll, [settleAll])

  return { markOpened, settleListing }
}
