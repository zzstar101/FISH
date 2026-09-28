import type { ListingCard } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Link } from '@tanstack/react-router'
import { Ban, Clock } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { rememberAttribution, trackEvent } from '../recommendation/track'
import { useImpressionTracking } from '../recommendation/use-impressions'

/**
 * 这张卡片在推荐 Feed 里的归因上下文。
 * 搜索、分类列表没有推荐请求，因此是 `undefined`，卡片也就不会发曝光事件。
 */
export type CardImpression = { requestId: string | null; position: number; pageIndex: number }

/** PC 商品卡：图上信息下，保持桌面四列网格的稳定高度。 */
export function PcListingCard({
  item,
  impression,
  onHide,
}: {
  item: ListingCard
  impression?: CardImpression
  onHide?: (listingId: string) => void
}) {
  const { cardRef, markOpened } = useImpressionTracking({
    listingId: item.id,
    requestId: impression?.requestId ?? null,
    position: impression?.position ?? 0,
    pageIndex: impression?.pageIndex ?? 0,
  })

  function handleOpen() {
    // 点开卡片：这段可见不再算「快速划过」，并把归因留给详情页。
    markOpened()
    if (impression === undefined || impression.requestId === null) return
    rememberAttribution(item.id, {
      requestId: impression.requestId,
      position: impression.position,
    })
  }

  function handleHide() {
    // 主动隐藏也是一次交互，不该同时被记成「快速划过」。
    markOpened()
    // HIDE 本身就是行为信号：来自推荐就带上归因，其它入口（搜索/分类）没有归因也照发。
    trackEvent({
      listingId: item.id,
      eventType: 'HIDE',
      requestId: impression?.requestId ?? null,
      position: impression?.position ?? null,
    })
    onHide?.(item.id)
  }

  return (
    <div className="group relative h-full" ref={cardRef}>
      <Link
        className="block h-full"
        onClick={handleOpen}
        params={{ listingId: item.id }}
        to="/listing/$listingId"
      >
        <Card className="h-full gap-0 overflow-hidden border border-line p-0 transition-all duration-200 group-hover:-translate-y-1 group-hover:border-brand/40 group-hover:shadow-lg">
          <div className="relative">
            <ListingThumb
              alt={item.title}
              className="h-[220px] w-full rounded-none"
              coverUrl={item.coverUrl}
              emojiClassName="text-6xl"
              listingId={item.id}
            />
            {item.urgent ? (
              <Badge
                className="absolute top-3 left-3 h-auto px-2 py-1"
                shape="pill"
                variant="danger"
              >
                急出
              </Badge>
            ) : null}
          </div>
          <div className="flex min-h-[132px] flex-1 flex-col p-4">
            <h2 className="line-clamp-2 min-h-[44px] font-medium text-[15px] leading-[1.45]">
              {item.title}
            </h2>
            <p className="mt-2 flex items-center gap-1.5 text-ink-3 text-xs">
              <Clock className="size-3.5" />
              {formatRelativeTimeAt(item.createdAt)}发布 · {categoryLabel(item.category)}
            </p>
            <div className="mt-auto flex items-end justify-between gap-3 pt-4">
              <PriceText
                cents={item.priceCents}
                className="font-bold text-[22px]"
                symbolClassName="text-[13px]"
              />
              {item.negotiable ? (
                <Badge shape="pill" variant="secondary">
                  可小刀
                </Badge>
              ) : null}
            </div>
          </div>
        </Card>
      </Link>
      {onHide === undefined ? null : (
        <button
          aria-label="不感兴趣"
          className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-full bg-surface/90 px-2.5 py-1.5 text-ink-2 text-xs opacity-0 shadow-sm transition-opacity hover:text-brand focus-visible:opacity-100 group-hover:opacity-100"
          onClick={handleHide}
          type="button"
        >
          <Ban className="size-3.5" />
          不感兴趣
        </button>
      )}
    </div>
  )
}
