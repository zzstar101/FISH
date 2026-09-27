import { type WishDto, type WishStatus, wishStatusSchema } from '@fish/contracts/wishes/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { CheckCircle2, Pencil, Plus, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { type WishStatusFilter, wishActionError } from './api'
import type { MatchTarget } from './match-list'
import { useMyWishes, useTransitionWish } from './queries'

const STATUS_FILTERS: ReadonlyArray<{ value: WishStatusFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: wishStatusSchema.enum.ACTIVE, label: '进行中' },
  { value: wishStatusSchema.enum.FULFILLED, label: '已达成' },
  { value: wishStatusSchema.enum.CLOSED, label: '已关闭' },
]

const STATUS_VIEW: Record<
  WishStatus,
  { label: string; variant: 'success' | 'secondary' | 'brand' }
> = {
  ACTIVE: { label: '许愿中', variant: 'success' },
  FULFILLED: { label: '已达成', variant: 'brand' },
  CLOSED: { label: '已关闭', variant: 'secondary' },
}

export function MyWishes({
  ownerId,
  onCreate,
  onEdit,
  onOpenMatch,
}: {
  ownerId: string
  onCreate: () => void
  onEdit: (wish: WishDto) => void
  onOpenMatch: (target: MatchTarget) => void
}) {
  const [status, setStatus] = useState<WishStatusFilter>('ALL')
  const [page, setPage] = useState(1)
  const [notice, setNotice] = useState<string | null>(null)
  const wishes = useMyWishes(ownerId, status, page)
  const transition = useTransitionWish(ownerId)
  const total = wishes.data?.total ?? 0
  const pageSize = wishes.data?.pageSize ?? 50
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    if (wishes.data !== undefined && page > totalPages) setPage(totalPages)
  }, [page, totalPages, wishes.data])

  async function changeStatus(wish: WishDto, action: 'close' | 'fulfill') {
    setNotice(null)
    try {
      await transition.mutateAsync({ id: wish.id, action })
    } catch (error) {
      const view = wishActionError(error)
      setNotice(view.message)
      if (view.refresh) await wishes.refetch()
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-5">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((item) => {
            const active = item.value === status
            return (
              <button
                aria-pressed={active}
                className={`h-9 rounded-full px-4 text-sm transition-colors ${
                  active
                    ? 'bg-brand font-semibold text-white'
                    : 'bg-surface text-ink-2 hover:bg-brand-soft hover:text-brand'
                }`}
                key={item.value}
                onClick={() => {
                  setStatus(item.value)
                  setPage(1)
                  setNotice(null)
                }}
                type="button"
              >
                {item.label}
              </button>
            )
          })}
        </div>
        <Button onClick={onCreate}>
          <Plus className="size-4" />
          发布愿望
        </Button>
      </div>

      {notice !== null ? (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {notice}
        </p>
      ) : null}
      {wishes.isPending ? <LoadingState label="正在加载我的愿望…" /> : null}
      {wishes.isError ? (
        <ErrorState message="我的愿望加载失败" onRetry={() => void wishes.refetch()} />
      ) : null}
      {wishes.isSuccess && wishes.data.items.length === 0 ? (
        <EmptyState
          action={<Button onClick={onCreate}>发布第一个愿望</Button>}
          description="描述想要的东西，Worker 会异步匹配在售商品"
          emoji="🌟"
          title="还没有愿望"
        />
      ) : null}

      {wishes.data !== undefined && wishes.data.items.length > 0 ? (
        <div className="grid grid-cols-2 gap-4">
          {wishes.data.items.map((wish) => {
            const statusView = STATUS_VIEW[wish.status]
            const pending = transition.isPending && transition.variables?.id === wish.id
            return (
              <Card className="gap-0 border border-line p-5" key={wish.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-lg">{wish.keyword}</h3>
                    <p className="mt-1 text-ink-3 text-sm">
                      {categoryLabel(wish.category)} · {formatBudget(wish)}
                    </p>
                  </div>
                  <Badge variant={statusView.variant}>{statusView.label}</Badge>
                </div>

                {wish.description !== null ? (
                  <p className="mt-4 line-clamp-2 text-ink-2 text-sm leading-6">
                    {wish.description}
                  </p>
                ) : (
                  <p className="mt-4 text-ink-3 text-sm">未填写描述</p>
                )}

                <div className="mt-4 flex items-center justify-between text-ink-3 text-xs">
                  <span>历史匹配记录数：{wish.matchCount}</span>
                  <span>{formatRelativeTimeAt(wish.createdAt)}发布</span>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    onClick={() => onOpenMatch({ kind: 'wish', id: wish.id, title: wish.keyword })}
                    size="sm"
                    variant="outline"
                  >
                    查看匹配
                  </Button>
                  {wish.status === 'ACTIVE' ? (
                    <>
                      <Button onClick={() => onEdit(wish)} size="sm" variant="outline">
                        <Pencil className="size-3.5" />
                        编辑
                      </Button>
                      <Button
                        disabled={pending}
                        onClick={() => void changeStatus(wish, 'fulfill')}
                        size="sm"
                      >
                        <CheckCircle2 className="size-3.5" />
                        完成
                      </Button>
                      <Button
                        disabled={pending}
                        onClick={() => void changeStatus(wish, 'close')}
                        size="sm"
                        variant="destructive"
                      >
                        <XCircle className="size-3.5" />
                        关闭
                      </Button>
                    </>
                  ) : null}
                </div>
              </Card>
            )
          })}
        </div>
      ) : null}

      {wishes.data !== undefined && total > 0 ? (
        <div className="flex items-center justify-between gap-4 rounded-xl bg-surface px-4 py-3 text-sm">
          <span className="text-ink-3">
            共 {total} 条 · 第 {page} / {totalPages} 页
          </span>
          {totalPages > 1 ? (
            <div className="flex gap-2">
              <Button
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                size="sm"
                variant="outline"
              >
                上一页
              </Button>
              <Button
                disabled={page >= totalPages}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                size="sm"
                variant="outline"
              >
                下一页
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function formatBudget(wish: WishDto): string {
  const min = wish.budgetMinCents
  const max = wish.budgetMaxCents
  if (min === 0) return `预算 ≤ ${formatPrice(max)}`
  return min === max ? `预算 ${formatPrice(max)}` : `预算 ${formatPrice(min)} ~ ${formatPrice(max)}`
}
