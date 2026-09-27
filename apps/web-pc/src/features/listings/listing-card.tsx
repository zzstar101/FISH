import type { ListingCard } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Link } from '@tanstack/react-router'
import { Clock } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'

/** PC 商品卡：图上信息下，保持桌面四列网格的稳定高度。 */
export function PcListingCard({ item }: { item: ListingCard }) {
  return (
    <Link params={{ listingId: item.id }} to="/listing/$listingId">
      <Card className="group h-full gap-0 overflow-hidden border border-line p-0 transition-all duration-200 hover:-translate-y-1 hover:border-brand/40 hover:shadow-lg">
        <div className="relative">
          <ListingThumb
            alt={item.title}
            className="h-[220px] w-full rounded-none"
            coverUrl={item.coverUrl}
            emojiClassName="text-6xl"
            listingId={item.id}
          />
          {item.urgent ? (
            <Badge className="absolute top-3 left-3 h-auto px-2 py-1" shape="pill" variant="danger">
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
  )
}
