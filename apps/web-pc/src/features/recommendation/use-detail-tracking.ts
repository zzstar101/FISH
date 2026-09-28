import { RECOMMENDATION_THRESHOLDS } from '@fish/contracts/recommendation/schema'
import { type ListingId, ListingIdSchema } from '@fish/contracts/system/public-id'
import { useEffect, useRef } from 'react'
import { consumeAttribution, trackListingEvent } from './track'

/**
 * 详情页行为（#323 R1）：详情数据真的就绪才发 DETAIL_VIEW（`ready`），**可见**停留
 * 累计达到契约阈值再发 LONG_VIEW。
 *
 * 计时口径只算页面可见时的停留。切到后台后 `setTimeout` 会被节流甚至冻结，用挂钟计时
 * 会在用户早就离开之后才回调，把「没看」记成「长浏览」；隐藏即暂停、回到前台按已累计
 * 时长续上剩余时间，`metadata.durationMs` 才是用户真的看了多久（与小程序端口径一致）。
 *
 * 归因（requestId / position）在本次详情页浏览开始时消费一次（`consumeAttribution`），
 * DETAIL_VIEW 与随后的 LONG_VIEW 共用同一份；消费后持久化条目即被删掉，所以换个入口
 * （搜索 / 分类）再进同一件商品时不再被算作推荐进来的。
 */
export function useDetailTracking(listingId: string, ready: boolean): void {
  /** 本页实例正在跟踪的商品：StrictMode 二次执行时不重复发 DETAIL_VIEW、不重复消费归因。 */
  const trackedIdRef = useRef<ListingId | null>(null)
  /** 已经累计的可见停留时长（毫秒）。 */
  const dwellRef = useRef(0)
  /** 当前这段可见计时的起点；页面不可见时为 null，表示暂停。 */
  const runningSinceRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  /** LONG_VIEW 只发一次。 */
  const longViewSentRef = useRef(false)

  useEffect(() => {
    // 详情还没就绪（加载中 / 404）：一条事件都不发，不存在的商品不该记一次浏览。
    if (!ready) return
    // 路由参数是裸字符串，而事件契约要求规范的公开 id（`lst_...`）。
    // 不是规范的 id 就不上报：那种链接服务端本来也取不到详情。
    const parsed = ListingIdSchema.safeParse(listingId)
    if (!parsed.success) return
    const publicListingId = parsed.data

    const clearTimer = () => {
      if (timerRef.current === null) return
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    /** 暂停计时：把正在跑的一段并进累计时长，清掉未响的定时器。 */
    const pause = () => {
      const since = runningSinceRef.current
      if (since !== null) {
        dwellRef.current += performance.now() - since
        runningSinceRef.current = null
      }
      clearTimer()
    }

    /** 继续计时：剩余时长按已累计的可见时长算，从后台回来不会把 10s 从头重走一遍。 */
    const resume = () => {
      if (longViewSentRef.current || runningSinceRef.current !== null) return
      // 页面不可见时不计时；重新可见会由 visibilitychange 续上。
      if (document.visibilityState === 'hidden') return
      runningSinceRef.current = performance.now()
      const remaining = Math.max(
        0,
        RECOMMENDATION_THRESHOLDS.longViewMinDurationMs - dwellRef.current,
      )
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (longViewSentRef.current) return
        longViewSentRef.current = true
        const since = runningSinceRef.current
        runningSinceRef.current = null
        const durationMs = dwellRef.current + (since === null ? 0 : performance.now() - since)
        trackListingEvent({
          listingId: publicListingId,
          eventType: 'LONG_VIEW',
          metadata: { durationMs: Math.round(durationMs) },
        })
      }, remaining)
    }

    // 换了一件商品（同一路由实例内参数变化）才重置；StrictMode 二次执行同一件商品不重置。
    if (trackedIdRef.current !== publicListingId) {
      trackedIdRef.current = publicListingId
      clearTimer()
      dwellRef.current = 0
      runningSinceRef.current = null
      longViewSentRef.current = false
      // 消费归因：本次浏览的 DETAIL_VIEW / LONG_VIEW / IMAGE_VIEW 共用这一份。
      consumeAttribution(publicListingId)
      // StrictMode 下 effect 会执行两次：DETAIL_VIEW 只发一次，避免开发期浏览计数翻倍。
      trackListingEvent({ listingId: publicListingId, eventType: 'DETAIL_VIEW' })
    }
    resume()

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        pause()
        return
      }
      resume()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // 没待够阈值就离开详情页：清掉计时器，不发 LONG_VIEW。
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      pause()
    }
  }, [listingId, ready])
}
