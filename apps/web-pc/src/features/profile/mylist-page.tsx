import type { ListingCard, ListingStatus } from '@fish/contracts/listings/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { useAuth } from '../auth/auth-provider'
import type { MyListingStatusFilter } from './api'
import { listingActionError } from './api'
import { EditListingDialog } from './edit-listing-dialog'
import { useMyListings, useSetListingStatus } from './queries'

const STATUS_TABS: ReadonlyArray<{ value: MyListingStatusFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'ACTIVE', label: '在售' },
  { value: 'OFFLINE', label: '已下架' },
  { value: 'RESERVED', label: '已预定' },
  { value: 'SOLD', label: '已售出' },
]

const STATUS_LABEL: Record<ListingStatus, string> = {
  ACTIVE: '在售',
  OFFLINE: '已下架',
  RESERVED: '已预定',
  SOLD: '已售出',
}

export function MyListPage() {
  const { me } = useAuth()
  if (!me) return null
  return <MyListContent key={me.id} ownerId={me.id} />
}

function MyListContent({ ownerId }: { ownerId: string }) {
  const [status, setStatus] = useState<MyListingStatusFilter>('ALL')
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<ListingCard | null>(null)
  const listings = useMyListings(ownerId, status)
  const setStatusMutation = useSetListingStatus(ownerId)

  async function toggle(item: ListingCard) {
    const target = item.status === 'ACTIVE' ? 'OFFLINE' : 'ACTIVE'
    setNotice(null)
    try {
      await setStatusMutation.mutateAsync({ id: item.id, status: target })
    } catch (error) {
      const view = listingActionError(error)
      setNotice(view.message)
      if (view.refresh) await listings.refetch()
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的发布</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            管理在售与已下架商品；交易中的商品不可手动上下架。
          </p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 最多显示 50 条</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_TABS.map((tab) => {
          const active = tab.value === status
          return (
            <button
              aria-pressed={active}
              className={`h-9 rounded-full px-4 text-sm transition-colors ${
                active
                  ? 'bg-brand font-semibold text-white'
                  : 'bg-surface text-ink-2 hover:bg-brand-soft hover:text-brand'
              }`}
              key={tab.value}
              onClick={() => {
                setStatus(tab.value)
                setNotice(null)
              }}
              type="button"
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {notice !== null ? (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {notice}
        </p>
      ) : null}

      {listings.isPending ? <LoadingState label="正在加载我的发布…" /> : null}
      {listings.isError ? (
        <ErrorState message="我的发布加载失败" onRetry={() => void listings.refetch()} />
      ) : null}
      {listings.isSuccess && listings.data.items.length === 0 ? (
        <EmptyState
          action={
            <Link
              className="inline-flex h-9 items-center rounded-full bg-brand px-4 font-medium text-sm text-white hover:bg-lavender"
              to="/publish"
            >
              去发布闲置
            </Link>
          }
          description="发布后的商品会在这里显示"
          emoji="📦"
          title="还没有商品"
        />
      ) : null}

      {listings.data !== undefined && listings.data.items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {listings.data.items.map((item) => {
            const statusView = listingStatusView(item)
            const actionEnabled = item.moderationStatus === 'APPROVED' && statusView.actionable
            const editEnabled =
              item.moderationStatus === 'APPROVED' &&
              (item.status === 'ACTIVE' || item.status === 'OFFLINE')
            const pending =
              setStatusMutation.isPending && setStatusMutation.variables?.id === item.id

            return (
              <article className="flex items-center gap-5 p-5" key={item.id}>
                <Link params={{ listingId: item.id }} to="/listing/$listingId">
                  <ListingThumb
                    alt={item.title}
                    className="size-28 rounded-2xl"
                    coverUrl={item.coverUrl}
                    listingId={item.id}
                  />
                </Link>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Link
                        className="line-clamp-1 font-semibold text-lg hover:text-brand"
                        params={{ listingId: item.id }}
                        to="/listing/$listingId"
                      >
                        {item.title}
                      </Link>
                      <p className="mt-1.5 text-ink-3 text-sm">
                        {categoryLabel(item.category)} · {formatRelativeTimeAt(item.createdAt)}发布
                      </p>
                    </div>
                    <Badge variant={statusView.variant}>{statusView.label}</Badge>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-4">
                    <p className="font-bold text-xl text-danger">
                      ¥{(item.priceCents / 100).toFixed(2)}
                    </p>
                    <div className="flex items-center gap-2">
                      {editEnabled ? (
                        <Button onClick={() => setEditing(item)} size="sm" variant="outline">
                          编辑
                        </Button>
                      ) : null}
                      {actionEnabled ? (
                        <Button
                          disabled={pending}
                          onClick={() => void toggle(item)}
                          size="sm"
                          variant="outline"
                        >
                          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                          {item.status === 'ACTIVE' ? '下架' : '重新上架'}
                        </Button>
                      ) : null}
                      {!actionEnabled && !editEnabled ? (
                        <span className="text-ink-3 text-xs">
                          {item.moderationStatus === 'REVIEW'
                            ? '审核通过后可在 PC 端上架'
                            : item.moderationStatus === 'BLOCKED'
                              ? '审核未通过'
                              : '当前状态不可手动操作'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            )
          })}
        </Card>
      ) : null}

      {editing !== null ? (
        <EditListingDialog
          key={editing.id}
          listing={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          open
          ownerId={ownerId}
        />
      ) : null}
    </div>
  )
}

function listingStatusView(item: ListingCard): {
  label: string
  variant: 'brand' | 'secondary' | 'warn' | 'success' | 'danger'
  actionable: boolean
} {
  if (item.moderationStatus === 'REVIEW') {
    return { label: '审核中', variant: 'warn', actionable: false }
  }
  if (item.moderationStatus === 'BLOCKED') {
    return { label: '审核未通过', variant: 'danger', actionable: false }
  }
  if (item.status === 'ACTIVE')
    return { label: STATUS_LABEL.ACTIVE, variant: 'success', actionable: true }
  if (item.status === 'OFFLINE')
    return { label: STATUS_LABEL.OFFLINE, variant: 'secondary', actionable: true }
  if (item.status === 'RESERVED') {
    return { label: STATUS_LABEL.RESERVED, variant: 'warn', actionable: false }
  }
  return { label: STATUS_LABEL.SOLD, variant: 'brand', actionable: false }
}
