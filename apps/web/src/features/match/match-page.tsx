import type { ListingMatchItem } from '@fish/contracts/matching/schema'
import { Badge } from '@fish/ui/badge'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useQuery } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { useListing } from '../listing-detail/queries'
import { fetchListingMatches } from './api'

/** Top 3 之外的命中折叠进「其余命中」，避免长列表把页面撑得太长。 */
const TOP_LIMIT = 3

/**
 * 匹配页（#8）：商品 → 想买 TA 的愿望。
 *
 * 真实契约（#41，#8 Freeze）的读模型是「愿望摘要」（关键词 / 分类 / 预算区间）：
 * 愿望没有公开的作者信息，这里**不渲染**任何命中者个人资料——
 * 与 Mock 时代的「同学头像 + 主页跳转」相比是信息降维，但不伪造契约之外的字段。
 */

/** 预算文案：预算 0 是「不设下限」而不是「免费送」（formatPrice 的 0 元是商品语义）。 */
function formatBudget(cents: number): string {
  return cents === 0 ? '¥0' : formatPrice(cents)
}

export function MatchPage({ listingId }: { listingId: string }) {
  const listing = useListing(listingId)
  const matches = useQuery({
    queryKey: ['match', 'listing', listingId],
    queryFn: () => fetchListingMatches(listingId),
    enabled: listingId.length > 0,
  })
  const results = matches.data?.items ?? []
  const total = matches.data?.total ?? 0
  const top = results.slice(0, TOP_LIMIT)
  const rest = results.slice(TOP_LIMIT)

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="匹配" />
      </div>

      {listing.isPending ? <LoadingState /> : null}
      {listing.isError ? (
        <ErrorState message="商品加载失败" onRetry={() => void listing.refetch()} />
      ) : null}
      {matches.isPending ? <LoadingState /> : null}
      {matches.isError ? (
        <ErrorState message="匹配结果加载失败" onRetry={() => void matches.refetch()} />
      ) : null}

      {listing.data ? (
        <section className="m-3 flex items-center gap-3 rounded-2xl bg-surface p-3">
          <ListingThumb
            alt={listing.data.title}
            className="size-14 rounded-xl"
            coverUrl={listing.data.coverUrl}
            listingId={listing.data.id}
            emojiClassName="text-[1.8rem]"
          />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5">
              <MessageCircle className="size-4 shrink-0 text-brand" />
              <span className="line-clamp-1 font-medium text-[15px]">{listing.data.title}</span>
            </p>
            <p className="mt-1 truncate text-ink-3 text-xs">
              {formatPrice(listing.data.priceCents)} · {categoryLabel(listing.data.category)}
            </p>
          </div>
        </section>
      ) : null}

      {/*
        加载失败时下面的标题与空态整块不渲染：否则 ErrorState 在说「加载失败」，
        紧跟着的标题却在说「暂无命中」，两句话互相矛盾。
      */}
      {matches.isPending || matches.isError ? null : (
        <>
          <h2 className="flex items-baseline justify-between px-4 py-2 font-semibold text-[15px]">
            {total > 0 ? 'Top 3 最对口的愿望' : '想买 TA 的愿望'}
            <span className="font-normal text-ink-3 text-xs">
              {total > 0 ? `共 ${total} 条命中 · 按匹配度排序` : '暂无命中'}
            </span>
          </h2>

          {total === 0 ? (
            <EmptyState description="暂时没有足够匹配的对象,发布的内容越多匹配越准" emoji="🧩" />
          ) : null}
        </>
      )}

      {top.length > 0 ? (
        <ul className="divide-y divide-line bg-surface">
          {top.map((item, index) => (
            <li key={item.id}>
              <MatchRow item={item} rank={index + 1} />
            </li>
          ))}
        </ul>
      ) : null}

      {rest.length > 0 ? (
        <>
          <h2 className="px-4 pt-4 pb-2 font-semibold text-[15px]">其余命中</h2>
          <ul className="divide-y divide-line bg-surface">
            {rest.map((item) => (
              <li key={item.id}>
                <MatchRow item={item} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}

/** 单条命中：愿望摘要 + 匹配度。愿望没有公开作者，行内不渲染用户信息。 */
function MatchRow({ item, rank }: { item: ListingMatchItem; rank?: number }) {
  // #8 契约：category / 预算上下限都照抄 DB 真值，可空（空 = 不限）。
  const min = item.wish.budgetMinCents
  const max = item.wish.budgetMaxCents
  const budget =
    min !== null && max !== null
      ? min === max
        ? formatBudget(max)
        : `${formatBudget(min)} ~ ${formatBudget(max)}`
      : min !== null
        ? `≥ ${formatBudget(min)}`
        : max !== null
          ? `≤ ${formatBudget(max)}`
          : '不限'
  const category = item.wish.category ? categoryLabel(item.wish.category) : '不限分类'

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          {rank === undefined ? null : (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft font-semibold text-[11px] text-brand">
              {rank}
            </span>
          )}
          <span className="truncate font-medium text-[15px]">想要「{item.wish.keyword}」</span>
        </p>
        <p className="mt-1 truncate text-ink-2 text-xs">
          {category} · 预算 {budget}
        </p>
      </div>
      <Badge variant="brand">{item.score}%</Badge>
    </div>
  )
}
