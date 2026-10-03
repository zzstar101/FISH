import type { ListingCard } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Bookmark, Heart } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { formatRelativeTimeAt } from '../../lib/format'

export type FavoriteRow = { listing: ListingCard; favoritedAt: string }

/** 单条取消的失败：按条挂在对应行上，不弹全局提示——失败的那条保持原样可重试。 */
export type CancelFailure = { listingId: string; message: string } | null

export type FavoritesViewProps = {
  loading: boolean
  error: boolean
  items: FavoriteRow[]
  /** 列表全量计数（与服务端 `total` 同源）；读不到为 null，显示未知而非 0。 */
  total: number | null
  hasNextPage: boolean
  loadingMore: boolean
  cancelingId: string | null
  cancelFailure: CancelFailure
  onRetry: () => void
  onCancel: (listingId: string) => void
  onLoadMore: () => void
}

const STATUS_VIEW: Record<
  ListingCard['status'],
  { label: string; variant: 'brand' | 'secondary' | 'warn' | 'success' }
> = {
  ACTIVE: { label: '在售', variant: 'success' },
  RESERVED: { label: '已预定', variant: 'warn' },
  SOLD: { label: '已售出', variant: 'brand' },
  OFFLINE: { label: '已下架', variant: 'secondary' },
}

/** 收藏卡的状态徽标：状态本身承载失效原因，不新增「是否失效」字段。 */
export function favoriteStatusView(item: ListingCard): {
  label: string
  variant: 'brand' | 'secondary' | 'warn' | 'success'
} {
  return STATUS_VIEW[item.status]
}

/** 按 `listing.status` 二分：在售一组、失效一组（已预定/已售出/已下架），组内保持收藏时间倒序。 */
export function groupFavorites(items: FavoriteRow[]): {
  active: FavoriteRow[]
  inactive: FavoriteRow[]
} {
  const active: FavoriteRow[] = []
  const inactive: FavoriteRow[] = []
  for (const row of items) {
    if (row.listing.status === 'ACTIVE') active.push(row)
    else inactive.push(row)
  }
  return { active, inactive }
}

function FavoriteCardRow({
  row,
  cancelFailure,
  canceling,
  onCancel,
}: {
  row: FavoriteRow
  cancelFailure: string | null
  canceling: boolean
  onCancel: (listingId: string) => void
}) {
  const status = favoriteStatusView(row.listing)
  const isFailureRow = cancelFailure !== null
  return (
    <Card
      className={`flex items-center gap-4 border border-line p-4 ${isFailureRow ? 'border-danger/40' : ''}`}
    >
      <Link params={{ listingId: row.listing.id }} to="/listing/$listingId">
        <ListingThumb
          alt={row.listing.title}
          className="size-20 rounded-xl"
          coverUrl={row.listing.coverUrl}
          emojiClassName="text-3xl"
          listingId={row.listing.id}
        />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="text-ink-3 text-xs">{formatRelativeTimeAt(row.favoritedAt)}收藏</span>
        </div>
        <Link
          className="mt-1.5 block truncate font-medium text-sm hover:text-brand"
          params={{ listingId: row.listing.id }}
          to="/listing/$listingId"
        >
          {row.listing.title}
        </Link>
        <PriceText cents={row.listing.priceCents} className="mt-1 font-semibold text-[15px]" />
        {isFailureRow ? <p className="mt-1 text-danger text-xs">{cancelFailure}</p> : null}
      </div>
      <Button
        aria-label={`取消收藏：${row.listing.title}`}
        disabled={canceling}
        onClick={() => onCancel(row.listing.id)}
        size="sm"
        type="button"
        variant="outline"
      >
        {canceling ? '取消中…' : '取消收藏'}
      </Button>
    </Card>
  )
}

function FavoritesGroup({
  icon,
  rows,
  title,
  cancelingId,
  cancelFailure,
  onCancel,
}: {
  icon: typeof Heart
  rows: FavoriteRow[]
  title: string
  cancelingId: string | null
  cancelFailure: CancelFailure
  onCancel: (listingId: string) => void
}) {
  if (rows.length === 0) return null
  const GroupIcon = icon
  return (
    <section aria-label={title} className="space-y-3">
      <h2 className="flex items-center gap-1.5 font-semibold text-sm">
        <GroupIcon className="size-4 text-brand" />
        {title}
        <span className="text-ink-3 font-normal">{rows.length} 件</span>
      </h2>
      {rows.map((row) => (
        <FavoriteCardRow
          cancelFailure={cancelFailure?.listingId === row.listing.id ? cancelFailure.message : null}
          canceling={cancelingId === row.listing.id}
          key={row.listing.id}
          onCancel={onCancel}
          row={row}
        />
      ))}
    </section>
  )
}

/** 收藏页展示层：props 驱动，供静态渲染测试；容器在 favorites-page.tsx。 */
export function FavoritesPageView(props: FavoritesViewProps) {
  if (props.loading) return <LoadingState label="正在加载收藏…" />

  if (props.error && props.items.length === 0) {
    return <ErrorState message="收藏列表加载失败" onRetry={props.onRetry} />
  }

  if (props.items.length === 0) {
    return (
      <EmptyState
        action={
          <Link
            className="rounded-lg bg-brand px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-lavender"
            to="/search"
          >
            去逛逛
          </Link>
        }
        description="看到喜欢的商品，点详情页的收藏心把它留在这里"
        emoji="🤍"
        title="还没有收藏"
      />
    )
  }

  const { active, inactive } = groupFavorites(props.items)

  return (
    <div className="space-y-6">
      <p className="text-ink-3 text-sm">
        共 {props.total === null ? '未知' : props.total} 件收藏
        {props.total === null ? '（计数暂不可用）' : ''}
      </p>
      <FavoritesGroup
        cancelFailure={props.cancelFailure}
        cancelingId={props.cancelingId}
        icon={Heart}
        onCancel={props.onCancel}
        rows={active}
        title="在售"
      />
      <FavoritesGroup
        cancelFailure={props.cancelFailure}
        cancelingId={props.cancelingId}
        icon={Bookmark}
        onCancel={props.onCancel}
        rows={inactive}
        title="已失效"
      />
      {props.hasNextPage ? (
        <div className="flex justify-center">
          <Button disabled={props.loadingMore} onClick={props.onLoadMore} variant="outline">
            {props.loadingMore ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}
      {props.error && props.items.length > 0 ? (
        <p className="text-center text-danger text-xs">
          加载更多失败，
          <button className="font-medium hover:underline" onClick={props.onRetry} type="button">
            重试
          </button>
        </p>
      ) : null}
    </div>
  )
}
