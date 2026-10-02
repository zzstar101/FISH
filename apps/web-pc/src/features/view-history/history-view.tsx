import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { formatRelativeTimeAt } from '../../lib/format'
import { groupHistoryByDay, historyDayLabel, historyStatusView } from './view'

export type HistoryViewProps = {
  loading: boolean
  /** 首屏失败（整体错误态）；「加载更多」失败走 `nextPageError`，不整页替换。 */
  error: boolean
  items: ViewHistoryItem[]
  hasNextPage: boolean
  loadingMore: boolean
  /** 翻页失败：保留已加载列表，行内给重试；不整页替换（与 chat 会话列表同款）。 */
  nextPageError: boolean
  /** 正在清空（按钮禁用 + 文案）。 */
  clearing: boolean
  /** 清空失败文案：失败时列表保持原样，只多一行错误提示。 */
  clearFailure: string | null
  onRetry: () => void
  onLoadMore: () => void
  onRetryNextPage: () => void
  onClear: () => void
  /** 分组标题的"今天/昨天"基准，注入以便测试确定化。 */
  now?: Date
}

function HistoryRow({ item }: { item: ViewHistoryItem }) {
  const status = historyStatusView(item.listing.status)
  // 已下架（OFFLINE）商品的详情页对非卖家是 404（`listings/service.ts` 的可见性判据），
  // 不给必然失败的入口（与 `chat/message-bubble.tsx` 的「已下架不给可点入口」同一约定）。
  // 已售出 / 已预定的详情公开可读，照常可点。
  const canOpen = item.listing.status !== 'OFFLINE'
  return (
    <Card className="flex items-center gap-4 border border-line p-4">
      {canOpen ? (
        <Link params={{ listingId: item.listing.id }} to="/listing/$listingId">
          <ListingThumb
            alt={item.listing.title}
            className="size-16 rounded-xl"
            coverUrl={item.listing.coverUrl}
            emojiClassName="text-2xl"
            listingId={item.listing.id}
          />
        </Link>
      ) : (
        <ListingThumb
          alt={item.listing.title}
          className="size-16 rounded-xl"
          coverUrl={item.listing.coverUrl}
          emojiClassName="text-2xl"
          listingId={item.listing.id}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="text-ink-3 text-xs">{formatRelativeTimeAt(item.viewedAt)}看过</span>
        </div>
        {canOpen ? (
          <Link
            className="mt-1.5 block truncate font-medium text-sm hover:text-brand"
            params={{ listingId: item.listing.id }}
            to="/listing/$listingId"
          >
            {item.listing.title}
          </Link>
        ) : (
          <p className="mt-1.5 truncate font-medium text-ink-3 text-sm">{item.listing.title}</p>
        )}
        <PriceText cents={item.listing.priceCents} className="mt-1 font-semibold text-[15px]" />
      </div>
    </Card>
  )
}

/** 浏览记录页（props 驱动，供静态渲染测试）；容器接线在 history-page.tsx。 */
export function HistoryView(props: HistoryViewProps) {
  if (props.loading) return <LoadingState label="正在加载浏览记录…" />

  if (props.error) {
    return <ErrorState message="浏览记录加载失败" onRetry={props.onRetry} />
  }

  if (props.items.length === 0) {
    return (
      <EmptyState
        description="看过的商品会按天收在这里，只保留最近 30 天。"
        emoji="🕘"
        title="还没有浏览记录"
      />
    )
  }

  const now = props.now ?? new Date()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-ink-3 text-sm">按最近浏览排序，同一天里最新的在前。</p>
        <Button disabled={props.clearing} onClick={props.onClear} type="button" variant="outline">
          {props.clearing ? '正在清空…' : '清空'}
        </Button>
      </div>

      {props.clearFailure !== null ? (
        <p className="text-danger text-sm">{props.clearFailure}</p>
      ) : null}

      {groupHistoryByDay(props.items).map((group) => (
        <section
          aria-label={historyDayLabel(group.date, now)}
          className="space-y-3"
          key={group.date}
        >
          <h2 className="font-semibold text-ink-2 text-sm">{historyDayLabel(group.date, now)}</h2>
          {group.items.map((item) => (
            <HistoryRow item={item} key={item.listing.id} />
          ))}
        </section>
      ))}

      {props.nextPageError ? (
        <ErrorState message="更多浏览记录加载失败" onRetry={props.onRetryNextPage} />
      ) : null}

      {props.hasNextPage && !props.nextPageError ? (
        <div className="flex justify-center">
          <Button disabled={props.loadingMore} onClick={props.onLoadMore} variant="outline">
            {props.loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
            {props.loadingMore ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}

      <p className="text-ink-3 text-xs">浏览记录只保留最近 30 天，更早的会自动清掉。</p>
    </div>
  )
}
