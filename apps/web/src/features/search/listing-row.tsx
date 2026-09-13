import type { ListingCard } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Link } from '@tanstack/react-router'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel, conditionLabel } from '../../lib/labels'

/**
 * 横向商品行：搜索结果、分类「热门闲置」、我的收藏、TA 的在售 都用它。
 * 与首页纵向卡片是同一份数据（#6 ListingCard）的两种版式。
 * 版式统一为「图片占 3 份宽 + 信息占 2 份宽」。
 *
 * `showTime=false` 用于分类页：那里的右下角只剩发布时间之外的元信息。
 */
export function ListingRow({ item, showTime = true }: { item: ListingCard; showTime?: boolean }) {
  const meta = [categoryLabel(item.category), conditionLabel(item.condition)]
    .filter(Boolean)
    .join(' · ')

  /** #6 卡片只有三个布尔标记；标签展示由它们推导，不引入契约之外的字段。 */
  const tags = [
    item.free ? '免费送' : null,
    item.urgent ? '急出' : null,
    item.negotiable ? '可小刀' : null,
  ].filter((tag): tag is string => tag !== null)

  return (
    <Link
      className="flex gap-2.5 bg-surface px-4 py-3"
      params={{ listingId: item.id }}
      to="/detail/$listingId"
    >
      <div className="w-3/5">
        <ListingThumb
          alt={item.title}
          className="!h-[96px] !w-full"
          coverUrl={item.coverUrl}
          listingId={item.id}
          emojiClassName="text-[2.2rem]"
        />
      </div>
      <div className="flex w-2/5 min-w-0 flex-col">
        <p className="line-clamp-2 text-[15px] text-ink leading-snug">{item.title}</p>
        <p className="mt-1 truncate text-ink-3 text-xs">{meta}</p>
        {tags.length > 0 ? (
          <div className="mt-1.5 flex flex-nowrap gap-1 overflow-hidden">
            {tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant={tag === '免费送' ? 'brand' : 'secondary'}>
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="mt-auto pt-1.5">
          <PriceText
            cents={item.priceCents}
            className="font-bold text-xl"
            symbolClassName="text-[13px]"
          />
          {showTime ? (
            <p className="truncate text-ink-3 text-xs">{formatRelativeTimeAt(item.createdAt)}</p>
          ) : null}
        </div>
      </div>
    </Link>
  )
}
