import { Badge } from '@fish/ui/badge'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import { formatPrice } from '../../lib/format'
import type { MatchResultView } from '../../lib/mock/store'
import { useMatches } from './queries'

/** Top 3 之外的命中折叠进「全部命中」，避免长列表把页面撑得太长。 */
const TOP_LIMIT = 3

/**
 * 匹配页（#8）：商品 → 想买 TA 的同学。
 *
 * 三块内容对应 #8 的前端工作项：**匹配总数**、**Top 3**（默认只展开前三条）、
 * **评分/原因**（`score` + `reason` 直接展示，简化即可）。P0 用 Mock。
 */
export function MatchPage({ listingId }: { listingId: string }) {
  const matches = useMatches(listingId)
  const listing = matches.data?.listing ?? null
  const results = matches.data?.results ?? []
  const total = matches.data?.total ?? 0
  const top = results.slice(0, TOP_LIMIT)
  const rest = results.slice(TOP_LIMIT)

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="匹配" />
      </div>

      {matches.isPending ? <LoadingState /> : null}
      {matches.isError ? (
        <ErrorState message="匹配结果加载失败" onRetry={() => void matches.refetch()} />
      ) : null}

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
              {formatPrice(listing.priceCents)} · {listing.campus}
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
            {total > 0 ? 'Top 3 最想买的同学' : '想买 TA 的同学'}
            <span className="font-normal text-ink-3 text-xs">
              {total > 0 ? `共 ${total} 人命中 · 按匹配度排序` : '暂无命中'}
            </span>
          </h2>

          {total === 0 ? (
            <EmptyState description="暂时没有足够匹配的对象,发布的内容越多匹配越准" emoji="🧩" />
          ) : null}
        </>
      )}

      {top.length > 0 ? (
        <ul className="divide-y divide-line bg-surface">
          {top.map((item) => (
            <li key={`${item.userId}-${item.wishId}`}>
              <MatchRow item={item} rank={results.indexOf(item) + 1} />
            </li>
          ))}
        </ul>
      ) : null}

      {rest.length > 0 ? (
        <>
          <h2 className="px-4 pt-4 pb-2 font-semibold text-[15px]">其余命中</h2>
          <ul className="divide-y divide-line bg-surface">
            {rest.map((item) => (
              <li key={`${item.userId}-${item.wishId}`}>
                <MatchRow item={item} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}

/** 单条命中：命中者 + 原因 + 匹配度；点进去是他的主页。 */
function MatchRow({ item, rank }: { item: MatchResultView; rank?: number }) {
  return (
    <Link
      className="flex items-center gap-3 px-4 py-3"
      params={{ userId: item.user.id }}
      to="/user/$userId"
    >
      <UserAvatar emoji={item.user.emoji} size="lg" tone={item.user.tone} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          {rank === undefined ? null : (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft font-semibold text-[11px] text-brand">
              {rank}
            </span>
          )}
          <span className="truncate font-medium text-[15px]">{item.user.nickname}</span>
          <span className="shrink-0 text-ink-3 text-xs">
            {item.user.college} · {item.user.campus}
          </span>
        </p>
        <p className="mt-1 truncate text-ink-2 text-xs">{item.reason}</p>
      </div>
      <Badge variant="brand">{item.score}%</Badge>
    </Link>
  )
}
