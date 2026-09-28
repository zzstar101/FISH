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
 * 同一次推荐请求内，同一 listing 的曝光与快速划过各只发一次。
 *
 * 标记放在模块级而不是组件 ref：卡片会因「不感兴趣」被移除、或因路由往返被卸载重建，
 * 组件级标记会跟着丢，同一次推荐请求里的同一张卡片就会被重复计数；反过来，服务端换了
 * 新的 requestId 时组件 ref 不会重置，卡片就再也发不出曝光。键含 requestId 同时解决两边。
 */
const emittedImpressions = new Set<string>()
const emittedQuickSkips = new Set<string>()

function emitKey(requestId: string, listingId: string): string {
  return `${requestId}:${listingId}`
}

/**
 * 曝光 / 快速划过（#323 R1）。
 *
 * 一张卡片一个 `IntersectionObserver`：可见比例达到契约阈值才开始计时，连续可见满
 * `impressionMinDurationMs` 发 IMPRESSION；没满就离开、且期间没点开，发 QUICK_SKIP。
 * 两种情况同一个 listing 在同一次推荐请求里最多各发一次。
 */
export function useImpressionTracking(target: ImpressionTarget): {
  cardRef: RefObject<HTMLDivElement | null>
  markOpened: () => void
} {
  const { listingId, requestId, position, pageIndex } = target
  const cardRef = useRef<HTMLDivElement | null>(null)
  const openedRef = useRef(false)
  /** 当前这段连续可见的开始时刻；null 表示没有在计时。 */
  const visibleSinceRef = useRef<number | null>(null)
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

    const key = emitKey(requestId, listingId)

    const clearTimer = () => {
      if (timerRef.current === null) return
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const emitImpression = (durationMs: number) => {
      if (emittedImpressions.has(key) || emittedQuickSkips.has(key)) return
      emittedImpressions.add(key)
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

    const startSegment = () => {
      if (visibleSinceRef.current !== null) return
      visibleSinceRef.current = performance.now()
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        const since = visibleSinceRef.current
        if (since === null) return
        emitImpression(performance.now() - since)
      }, RECOMMENDATION_THRESHOLDS.impressionMinDurationMs)
    }

    const settleSegment = () => {
      const since = visibleSinceRef.current
      visibleSinceRef.current = null
      clearTimer()
      if (since === null) return

      const durationMs = performance.now() - since
      if (durationMs >= RECOMMENDATION_THRESHOLDS.impressionMinDurationMs) {
        // 定时器被节流（后台标签页）时在这里补发，不会漏。
        emitImpression(durationMs)
        return
      }
      if (openedRef.current || emittedImpressions.has(key) || emittedQuickSkips.has(key)) return
      if (durationMs >= RECOMMENDATION_THRESHOLDS.quickSkipMaxDurationMs) return

      emittedQuickSkips.add(key)
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
        // 页面藏起来后"可见"不成立，先把当前这段结算掉。
        settleSegment()
        return
      }
      // 回到前台时若卡片仍在视口内，重新开始计时（隐藏期间的时长不计入）。
      if (intersectingRef.current) startSegment()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      // 卸载（翻页 / 被隐藏移除）时把正在计时的可见段结算掉，不能直接丢掉。
      settleSegment()
    }
  }, [listingId, position, pageIndex, requestId])

  return { cardRef, markOpened }
}
