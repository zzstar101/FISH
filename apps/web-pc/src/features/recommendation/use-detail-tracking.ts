import { RECOMMENDATION_THRESHOLDS } from '@fish/contracts/recommendation/schema'
import { ListingIdSchema } from '@fish/contracts/system/public-id'
import { useEffect, useRef } from 'react'
import { trackListingEvent } from './track'

/**
 * 详情页行为（#323 R1）：挂载即发 DETAIL_VIEW，停留达到契约阈值再发 LONG_VIEW。
 *
 * 归因（requestId / position）由 `trackListingEvent` 从点进卡片时写下的归因表里取；
 * 搜索、分类进来的浏览没有归因，事件照发，只是不带 requestId——那同样是有用的行为信号。
 */
export function useDetailTracking(listingId: string): void {
  const detailViewSentRef = useRef(false)

  useEffect(() => {
    // 路由参数是裸字符串，而事件契约要求规范的公开 id（`lst_...`）。
    // 不是规范的 id 就不上报：那种链接服务端本来也取不到详情。
    const parsed = ListingIdSchema.safeParse(listingId)
    if (!parsed.success) return
    const publicListingId = parsed.data

    // StrictMode 下 effect 会执行两次：DETAIL_VIEW 只发一次，避免开发期浏览计数翻倍。
    if (!detailViewSentRef.current) {
      detailViewSentRef.current = true
      trackListingEvent({ listingId: publicListingId, eventType: 'DETAIL_VIEW' })
    }

    const startedAt = performance.now()
    const timer = window.setTimeout(() => {
      trackListingEvent({
        listingId: publicListingId,
        eventType: 'LONG_VIEW',
        metadata: { durationMs: Math.round(performance.now() - startedAt) },
      })
    }, RECOMMENDATION_THRESHOLDS.longViewMinDurationMs)

    // 没待够阈值就离开详情页：清掉计时器，不发 LONG_VIEW。
    return () => window.clearTimeout(timer)
  }, [listingId])
}
