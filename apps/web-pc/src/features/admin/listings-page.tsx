import type { AdminListingSummary } from '@fish/contracts/admin/schema'
import { ListingStatusSchema } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { categoryLabel, conditionLabel } from '../../lib/labels'
import {
  DateRangeFilter,
  FilterChips,
  ForbiddenInline,
  KeywordFilter,
  LoadMore,
} from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminListings } from './admin-queries'
import {
  cursorSearch,
  dayParam,
  dayRangeSearch,
  optionalSearch,
  trimmedSearch,
  withoutCursor,
} from './admin-search'
import { formatAdminDateTime, listingStatusMeta } from './admin-view'

export type ListingsSearch = {
  q?: string
  status?: 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE'
  sellerId?: string
  from?: string
  to?: string
  cursor?: string
}

/** 商品查询页（#467 验收「商品：列表、筛选/分页、详情、审核与治理状态」）。 */
export function ListingsPage({ search }: { search: ListingsSearch }) {
  const navigate = useNavigate()
  const range = dayRangeSearch(search.from, search.to)
  const filters = {
    q: search.q,
    status: search.status,
    sellerId: search.sellerId,
    createdFrom: range.createdFrom,
    createdTo: range.createdTo,
  }
  const listings = useAdminListings(filters)

  if (listings.isError) {
    const outcome = adminLoadOutcome(listings.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="商品列表加载失败" onRetry={() => void listings.refetch()} />
  }

  const items = listings.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">商品</h1>
        <p className="mt-1.5 text-ink-3 text-sm">标题/描述子串搜索；时间段为左闭右开口径。</p>
      </div>

      <ListingsFilters search={search} />

      {search.sellerId !== undefined ? (
        <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-brand text-sm" role="status">
          正在按卖家过滤（{search.sellerId}），
          <button
            className="font-semibold underline"
            onClick={() =>
              void navigate({
                to: '/admin/listings',
                search: { ...withoutCursor(search), sellerId: undefined },
              })
            }
            type="button"
          >
            清除
          </button>
        </p>
      ) : null}

      {listings.isPending ? <LoadingState label="正在加载商品…" /> : null}
      {listings.isSuccess && items.length === 0 ? (
        <EmptyState description="换个关键词或清掉筛选试试" emoji="🔍" title="没有匹配的商品" />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <ListingRow key={item.id} listing={item} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={listings.isFetchNextPageError}
        hasNextPage={listings.hasNextPage}
        isFetchingNextPage={listings.isFetchingNextPage}
        onNext={() => void listings.fetchNextPage()}
        onRetry={() => void listings.fetchNextPage()}
      />
    </div>
  )
}

function ListingsFilters({ search }: { search: ListingsSearch }) {
  const navigate = useNavigate()

  function update(next: Partial<ListingsSearch>) {
    void navigate({ to: '/admin/listings', search: { ...withoutCursor(search), ...next } })
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <KeywordFilter
        onCommit={(q) => update({ q })}
        placeholder="标题或描述关键词"
        value={search.q}
      />
      <FilterChips
        ariaLabel="商品状态筛选"
        onChange={(status) => update({ status: status as ListingsSearch['status'] })}
        options={[
          { value: 'ACTIVE', label: '在售' },
          { value: 'RESERVED', label: '已预定' },
          { value: 'SOLD', label: '已售出' },
          { value: 'OFFLINE', label: '已下架' },
        ]}
        value={search.status}
      />
      <DateRangeFilter
        fromValue={search.from}
        onCommit={({ from, to }) => update({ from, to })}
        toValue={search.to}
      />
    </div>
  )
}

function ListingRow({ listing }: { listing: AdminListingSummary }) {
  const statusMeta = listingStatusMeta(listing.status)
  return (
    <Link
      className="flex items-center gap-4 p-4 transition-colors hover:bg-surface-2/60"
      params={{ listingId: listing.id }}
      to="/admin/listings/$listingId"
    >
      <ListingThumb
        alt={listing.title}
        className="size-16 shrink-0 rounded-xl"
        coverUrl={listing.coverUrl}
        listingId={listing.id}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{listing.title}</span>
          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
        </div>
        <p className="mt-1 text-ink-3 text-xs">
          {categoryLabel(listing.category)} · {conditionLabel(listing.condition)} · 卖家{' '}
          {listing.seller.nickname} · {formatAdminDateTime(listing.createdAt)}
        </p>
      </div>
      <PriceText cents={listing.priceCents} className="shrink-0 font-semibold" />
      <span aria-hidden className="text-ink-3 text-sm">
        ›
      </span>
    </Link>
  )
}

/** validateSearch 共用实现。 */
export function parseListingsSearch(search: Record<string, unknown>): ListingsSearch {
  const status = optionalSearch(ListingStatusSchema, search.status)
  const q = trimmedSearch(search.q)
  const sellerId =
    typeof search.sellerId === 'string' && search.sellerId.length > 0 ? search.sellerId : undefined
  const from = dayParam(search.from)
  const to = dayParam(search.to)
  const cursor = cursorSearch(search.cursor)
  return {
    ...(q !== undefined ? { q } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(sellerId !== undefined ? { sellerId } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
