import { Badge } from '@fish/ui/badge'
import { Thumb } from '@fish/ui/thumb'
import { Link } from '@tanstack/react-router'
import { PriceText } from '../../components/price-text'
import { formatRelativeTime } from '../../lib/format'
import type { ListingView } from '../../lib/mock/store'

/**
 * 横向商品行：搜索结果、分类「热门闲置」、我的收藏、TA 的在售 都用它。
 * 与首页横向卡片是同一份数据的两种版式。
 * 版式统一为「图片占 3 份宽 + 信息占 2 份宽」。
 *
 * `showTime=false` 用于分类页：那里的右侧只显示浏览数（截图 02 / 03）。
 */
export function ListingRow({ item, showTime = true }: { item: ListingView; showTime?: boolean }) {
  const meta = [item.category, item.condition, item.campus, item.tradeMethod]
    .filter((part) => part && part !== '—')
    .join(' · ')

  return (
    <Link
      className="flex gap-2.5 bg-surface px-4 py-3"
      params={{ listingId: item.id }}
      to="/detail/$listingId"
    >
      <div className="w-3/5">
        <Thumb
          className="!h-[96px] !w-full"
          emoji={item.emoji}
          emojiClassName="text-[2.2rem]"
          tone={item.tone}
        />
      </div>
      <div className="flex w-2/5 min-w-0 flex-col">
        <p className="line-clamp-2 text-[15px] text-ink leading-snug">{item.title}</p>
        <p className="mt-1 truncate text-ink-3 text-xs">{meta}</p>
        {item.tags.length > 0 || item.kind === 'wish' ? (
          <div className="mt-1.5 flex flex-nowrap gap-1 overflow-hidden">
            {item.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant={tag === '免费送' ? 'brand' : 'secondary'}>
                {tag}
              </Badge>
            ))}
            {item.kind === 'wish' ? <Badge variant="lavender">求购</Badge> : null}
          </div>
        ) : null}
        <div className="mt-auto pt-1.5">
          <PriceText
            cents={item.priceCents}
            className="font-bold text-xl"
            symbolClassName="text-[13px]"
          />
          <p className="truncate text-ink-3 text-xs">
            {showTime ? `${formatRelativeTime(item.publishedMinutesAgo)} · ` : ''}
            {item.views}人看过
          </p>
        </div>
      </div>
    </Link>
  )
}
