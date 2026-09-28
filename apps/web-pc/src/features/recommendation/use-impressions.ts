import { RECOMMENDATION_THRESHOLDS } from '@fish/contracts/recommendation/schema'
import type { ListingId } from '@fish/contracts/system/public-id'
import { type RefObject, useCallback, useEffect, useRef } from 'react'
import { trackEvent } from './track'

export type ImpressionTarget = {
  listingId: ListingId
  /** 没有推荐请求 id 就不是推荐来源（mock 回退等），此时不发曝光与快速划过。 */
  requestId: string | null
  position: number
  pageIndex: number
}

/**
 * 同一次推荐请求内，同一 listing 的曝光与快速划过**各**只发一次，两者互不阻塞。
 *
 * 标记放在模块级而不是组件 ref：卡片会因「不感兴趣」被移除、或因路由往返被卸载重建，
 * 组件级标记会跟着丢，同一次推荐请求里的同一张卡片就会被重复计数；反过来，服务端换了
 * 新的 requestId 时组件 ref 不会重置，卡片就再也发不出曝光。键含 requestId 同时解决两边。
 *
 * 两张表都会随浏览一直长，所以有两道边界：requestId 变了（服务端发了新一次推荐请求，
 * 旧 key 再也不会被查到）就整体清空；单表超过 MAX_EMITTED_KEYS 时按插入顺序 FIFO 淘汰。
 */
const emittedImpressions = new Set<string>()
const emittedQuickSkips = new Set<string>()
const MAX_EMITTED_KEYS = 256

/** 最近一次见过的推荐请求 id：变了就说明是新一次推荐，旧的去重标记全部作废。 */
let trackedRequestId: string | null = null

function emitKey(requestId: string, listingId: string): string {
  return `${requestId}:${listingId}`
}

/** 记一条去重标记；超过上限时按插入顺序（Set 保序）淘汰最早的。 */
function markEmitted(emitted: Set<string>, key: string): void {
  emitted.add(key)
  if (emitted.size <= MAX_EMITTED_KEYS) return
  const oldest = emitted.values().next().value
  if (oldest !== undefined) emitted.delete(oldest)
}

/** 换了推荐请求就清表：旧 requestId 的 key 不会再命中，留着只会无限增长。 */
function resetEmittedOnRequestChange(requestId: string): void {
  if (trackedRequestId === requestId) return
  trackedRequestId = requestId
  emittedImpressions.clear()
  emittedQuickSkips.clear()
}

/**
 * 曝光 / 快速划过（#323 R1）。
 *
 * 一张卡片一个 `IntersectionObserver`：可见比例达到契约阈值才开始计时，累计**可见**时长满
 * `impressionMinDurationMs` 发 IMPRESSION；没满就离开、且期间没点开，发 QUICK_SKIP。
 * 两种情况同一个 listing 在同一次推荐请求里各最多发一次：先被快速划过、后来又真的看够了
 * 的卡片仍要补一条曝光；已经发过曝光的卡片不会再被判成快速划过。
 *
 * 切标签页（`visibilitychange` → hidden）不算「离开视口」：只暂停计时、不上报，回到前台
 * 接着累计，隐藏期间既不计入时长，也不会把这段判成 QUICK_SKIP。
 */
export function useImpressionTracking(target: ImpressionTarget): {
  cardRef: RefObject<HTMLDivElement | null>
  markOpened: () => void
} {
  const { listingId, requestId, position, pageIndex } = target
  const cardRef = useRef<HTMLDivElement | null>(null)
  const openedRef = useRef(false)
  /** 当前这段可见计时的起点；null 表示没在计时（暂停中或已结算）。 */
  const visibleSinceRef = useRef<number | null>(null)
  /** 本段（进入视口 → 离开视口）已经累计的可见时长；页面隐藏时把跑着的一段并进来。 */
  const visibleMsRef = useRef(0)
  const visibleRatioRef = useRef(0)
  const intersectingRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  const markOpened = useCallback(() => {
    openedRef.current = true
  }, [])

  useEffect(() => {
    const element = cardRef.current
    // 没有 requestId 就没有推荐请求可归因：契约要求 IMPRESSION / QUICK_SKIP 必须带
    // requestId + position，缺了会让整批 422，所以这里直接不发。
    if (element === null || requestId === null) return

    resetEmittedOnRequestChange(requestId)
    const key = emitKey(requestId, listingId)

    const clearTimer = () => {
      if (timerRef.current === null) return
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    /** 本段累计的可见时长（不含页面隐藏期间）。 */
    const visibleMs = () => {
      const since = visibleSinceRef.current
      return visibleMsRef.current + (since === null ? 0 : performance.now() - since)
    }

    const emitImpression = (durationMs: number) => {
      // 曝光不吃快速划过的去重标记：两者各自最多一次，互不阻塞。
      if (emittedImpressions.has(key)) return
      markEmitted(emittedImpressions, key)
      trackEvent({
        listingId,
        eventType: 'IMPRESSION',
        requestId,
        position,
        metadata: {
          visibleRatio: visibleRatioRef.current,
          durationMs: Math.round(durationMs),
          pageIndex,
        },
      })
    }

    /** 开始或继续计时；剩余时长按已累计的可见时长算，从后台回来不会把 1s 从头再走一遍。 */
    const startSegment = () => {
      if (visibleSinceRef.current !== null) return
      // 页面不可见时不计时；回到前台会由 visibilitychange 续上。
      if (document.visibilityState === 'hidden') return
      visibleSinceRef.current = performance.now()
      clearTimer()
      const remaining = Math.max(
        0,
        RECOMMENDATION_THRESHOLDS.impressionMinDurationMs - visibleMsRef.current,
      )
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (visibleSinceRef.current === null) return
        emitImpression(visibleMs())
      }, remaining)
    }

    /** 页面隐藏：暂停计时，既不结算也不上报——切标签页不是「离开视口」。 */
    const pauseSegment = () => {
      const since = visibleSinceRef.current
      if (since !== null) {
        visibleMsRef.current += performance.now() - since
        visibleSinceRef.current = null
      }
      clearTimer()
    }

    /** 卡片真的离开视口（或卸载）：结算本段，按可见时长分曝光 / 快速划过。 */
    const settleSegment = () => {
      const wasTiming = visibleSinceRef.current !== null || visibleMsRef.current > 0
      const durationMs = visibleMs()
      visibleSinceRef.current = null
      visibleMsRef.current = 0
      clearTimer()
      if (!wasTiming) return

      if (durationMs >= RECOMMENDATION_THRESHOLDS.impressionMinDurationMs) {
        // 定时器被节流（后台标签页）时在这里补发，不会漏。
        emitImpression(durationMs)
        return
      }
      if (openedRef.current || emittedImpressions.has(key) || emittedQuickSkips.has(key)) return
      if (durationMs >= RECOMMENDATION_THRESHOLDS.quickSkipMaxDurationMs) return

      markEmitted(emittedQuickSkips, key)
      trackEvent({
        listingId,
        eventType: 'QUICK_SKIP',
        requestId,
        position,
        metadata: { durationMs: Math.round(durationMs) },
      })
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry === undefined) return
        const visible =
          entry.isIntersecting &&
          entry.intersectionRatio >= RECOMMENDATION_THRESHOLDS.impressionMinVisibleRatio
        intersectingRef.current = visible

        if (!visible) {
          settleSegment()
          return
        }
        visibleRatioRef.current = Math.min(1, Math.max(0, entry.intersectionRatio))
        startSegment()
      },
      // 只在跨过阈值时回调；可见比例不达标就完全不计时。
      { threshold: RECOMMENDATION_THRESHOLDS.impressionMinVisibleRatio },
    )
    observer.observe(element)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // 切标签页不是离开视口：只暂停计时，别把不足阈值的这一段判成快速划过。
        pauseSegment()
        return
      }
      // 回到前台时若卡片仍在视口内，接着累计（隐藏期间的时长不计入）。
      if (intersectingRef.current) startSegment()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (document.visibilityState === 'hidden') {
        // 页面本来就不可见（例如在后台标签页里被卸载）：隐藏不等于离开视口，不结算也不上报。
        pauseSegment()
        return
      }
      // 卸载（翻页 / 被隐藏移除）时把正在计时的可见段结算掉，不能直接丢掉。
      settleSegment()
    }
  }, [listingId, position, pageIndex, requestId])

  return { cardRef, markOpened }
}
