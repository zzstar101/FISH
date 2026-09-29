/**
 * 详情页的 DETAIL_VIEW 与 LONG_VIEW（Issue #323 R1 §3.5）。
 *
 * 计时口径：**只在页面可见时累计停留**。小程序切后台后定时器会被节流甚至冻结，
 * 一个裸的 10s 定时器会在用户早就离开之后才响，把「停留」记成实际时长；
 * 「隐藏即暂停、显示时补剩余时长」比裸定时器更接近用户真的看了多久。
 *
 * `listingId` 传 null 表示详情还没加载出来：那时不发事件 —— 商品不存在（加载失败 / 404）时
 * 发一条 DETAIL_VIEW 只会被服务端按 `listing_not_found` 拒收。
 */
import { RECOMMENDATION_THRESHOLDS } from '@fish/contracts/recommendation/schema'
import { useDidHide, useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef } from 'react'
import type { FeedAttribution } from './attribution'
import { trackRecommendationEvent } from './track'

export function useListingDetailTracking(
  listingId: string | null,
  attribution: FeedAttribution | null,
): void {
  /** 已经发过 DETAIL_VIEW 的商品：页面重载同一件商品时不再重复发 */
  const trackedIdRef = useRef<string | null>(null)
  /** 归因在本次页面实例内不变（来自路由参数），放 ref 里免得给每个回调都加依赖 */
  const attributionRef = useRef<FeedAttribution | null>(attribution)
  attributionRef.current = attribution
  /** 已经累计的可见停留时长 */
  const dwellRef = useRef(0)
  /** 当前这段可见计时的起点；不可见时为 null */
  const runningSinceRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longViewSentRef = useRef(false)
  const visibleRef = useRef(true)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** 暂停计时：把当前这一段并进累计时长，清掉未响的定时器 */
  const pause = useCallback(() => {
    const runningSince = runningSinceRef.current
    if (runningSince !== null) {
      dwellRef.current += Date.now() - runningSince
      runningSinceRef.current = null
    }
    clearTimer()
  }, [clearTimer])

  /** 开始（或继续）计时：剩余时长按已累计的算，所以后台回来不会把 10s 从头再走一遍 */
  const resume = useCallback(() => {
    const currentListingId = trackedIdRef.current
    if (!currentListingId || longViewSentRef.current || runningSinceRef.current !== null) return
    runningSinceRef.current = Date.now()
    const remaining = Math.max(
      0,
      RECOMMENDATION_THRESHOLDS.longViewMinDurationMs - dwellRef.current,
    )
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      longViewSentRef.current = true
      const runningSince = runningSinceRef.current
      const durationMs = dwellRef.current + (runningSince === null ? 0 : Date.now() - runningSince)
      // 规格：LONG_VIEW 只在**有归因**时带 requestId（没有归因也发，只是不带）
      trackRecommendationEvent({
        listingId: currentListingId,
        eventType: 'LONG_VIEW',
        attribution: attributionRef.current,
        metadata: { durationMs },
      })
    }, remaining)
  }, [])

  useEffect(() => {
    if (!listingId || trackedIdRef.current === listingId) return
    trackedIdRef.current = listingId
    dwellRef.current = 0
    runningSinceRef.current = null
    longViewSentRef.current = false
    clearTimer()
    /*
      详情挂载就发 DETAIL_VIEW；有归因（从推荐流点进来）才带 requestId + position，
      从搜索 / 分类 / 卖家主页进来的没有推荐来源 —— 硬塞一个假 requestId 会把归因污染成
      「看起来来自推荐」，所以宁可带 null。
    */
    trackRecommendationEvent({
      listingId,
      eventType: 'DETAIL_VIEW',
      attribution: attributionRef.current,
    })
    if (visibleRef.current) resume()
  }, [listingId, clearTimer, resume])

  useDidShow(() => {
    visibleRef.current = true
    resume()
  })

  useDidHide(() => {
    visibleRef.current = false
    pause()
  })

  // 卸载：停掉计时，避免定时器在页面销毁之后才响（那时会发出一条指向已离开详情的 LONG_VIEW）
  useEffect(() => pause, [pause])
}
