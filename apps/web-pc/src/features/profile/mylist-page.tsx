import type { ListingCard, ListingStatus } from '@fish/contracts/listings/schema'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@fish/ui/alert-dialog'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { useAuth } from '../auth/auth-provider'
import { WatchersDialog } from '../watchers/watchers-dialog'
import type { MyListingStatusFilter } from './api'
import { listingActionError, listingDeleteError } from './api'
import { EditListingDialog } from './edit-listing-dialog'
import { PendingSection } from './pending-section'
import { useDeleteListing, useMyListings, useSetListingStatus } from './queries'

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
  const [watching, setWatching] = useState<ListingCard | null>(null)
  const [deleting, setDeleting] = useState<ListingCard | null>(null)
  const listings = useMyListings(ownerId, status)
  const setStatusMutation = useSetListingStatus(ownerId)
  const deleteMutation = useDeleteListing(ownerId)

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

  async function remove(item: ListingCard) {
    setNotice(null)
    try {
      await deleteMutation.mutateAsync(item.id)
    } catch (error) {
      const view = listingDeleteError(error)
      setNotice(view.message)
      if (view.refresh) await listings.refetch()
    } finally {
      setDeleting(null)
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

      <PendingSection ownerId={ownerId} />

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
            const deletePending = deleteMutation.isPending && deleteMutation.variables === item.id

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
                    <MyListingPrice cents={item.priceCents} />
                    <div className="flex items-center gap-2">
                      <Button onClick={() => setWatching(item)} size="sm" variant="outline">
                        谁想要
                      </Button>
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
                      {isDeletableListing(item) ? (
                        <Button
                          disabled={deletePending}
                          onClick={() => setDeleting(item)}
                          size="sm"
                          variant="destructive"
                        >
                          {deletePending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                          删除
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

      {watching !== null ? (
        <WatchersDialog key={watching.id} listing={watching} onClose={() => setWatching(null)} />
      ) : null}

      {deleting !== null ? (
        <AlertDialog
          onOpenChange={(open) => {
            if (!open) setDeleting(null)
          }}
          open
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除「{deleting.title}」？</AlertDialogTitle>
              <AlertDialogDescription>
                删除不可恢复：商品、图片、评论与相关会话会一并清除。只是暂时不想卖请用「下架」，下架后还能重新上架。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => void remove(deleting)} variant="destructive">
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}

/** 我的发布卡片价格：复用全站 `PriceText`，0 元显示「免费送」而不是 `¥0.00`。 */
export function MyListingPrice({ cents }: { cents: number }) {
  return <PriceText cents={cents} className="font-bold text-xl" />
}

/**
 * 是否可删，与服务端 `store.deleteListingAtomic` 的判定一一对应：
 * `status === 'OFFLINE'` 且 `moderationStatus === 'BLOCKED'` 且**非治理下架**。
 *
 * `governanceDelisted` 必须参与判断：治理下架与「内容不过审」在库里的形态完全相同
 * （都是 `OFFLINE` + `BLOCKED`），只看 `moderationStatus` 会让平台下架的商品也顶着
 * 「不过审」摆一个按下去必然 409 的按钮（契约 `ListingCardSchema` 已就这一坑预警）。
 *
 * **「有没有交易记录」这一条客户端看不到** —— 满足上面三条仍可能被服务端 409
 * `LISTING_NOT_DELETABLE` 拒绝，所以调用方必须把失败透传，不能预先当成功。
 */
export function isDeletableListing(item: ListingCard): boolean {
  return (
    item.status === 'OFFLINE' &&
    item.moderationStatus === 'BLOCKED' &&
    item.governanceDelisted !== true
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
