import { Badge } from '@fish/ui/badge'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Thumb } from '@fish/ui/thumb'
import { MessageCircle } from 'lucide-react'
import { formatPrice } from '../../lib/format'
import { useMatches } from './queries'

/** 匹配页（#8）：商品 → 想买 TA 的同学。P0 用 Mock，空态与截图一致。 */
export function MatchPage({ listingId }: { listingId: string }) {
  const matches = useMatches(listingId)
  const listing = matches.data?.listing ?? null
  const results = matches.data?.results ?? []

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="匹配" />
      </div>

      {matches.isPending ? <LoadingState /> : null}

      {listing ? (
        <section className="m-3 flex items-center gap-3 rounded-2xl bg-surface p-3">
          <Thumb
            className="size-14 rounded-xl"
            emoji={listing.emoji}
            emojiClassName="text-[1.8rem]"
            tone={listing.tone}
          />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5">
              <MessageCircle className="size-4 shrink-0 text-brand" />
              <span className="line-clamp-1 font-medium text-[15px]">{listing.title}</span>
            </p>
            <p className="mt-1 truncate text-ink-3 text-xs">
              预算 {formatPrice(listing.priceCents)} 以内 · {listing.campus}
            </p>
          </div>
        </section>
      ) : null}

      <h2 className="flex items-baseline justify-between px-4 py-2 font-semibold text-[15px]">
        想买 TA 的同学
        <span className="font-normal text-ink-3 text-xs">
          {results.length} 个结果 · 按匹配度排序
        </span>
      </h2>

      {results.length === 0 && !matches.isPending ? (
        <EmptyState description="暂时没有足够匹配的对象,发布的内容越多匹配越准" emoji="🧩" />
      ) : null}

      {results.length > 0 ? (
        <ul className="divide-y divide-line bg-surface">
          {results.map((item) => (
            <li className="flex items-center gap-3 px-4 py-3" key={item.userId}>
              <span className="min-w-0 flex-1 truncate">{item.reason}</span>
              <Badge variant="brand">{item.score}%</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
