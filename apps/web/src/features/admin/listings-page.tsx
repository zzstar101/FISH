import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fish/ui/select'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { formatPrice } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { formatDateTime, LISTING_STATUS_LABEL, statusLabel } from './display'
import { useAdminListings } from './queries'

export type AdminListingsSearch = { q?: string; status?: string }

type PageState = { cursor: string | null; stack: (string | null)[] }

/**
 * 商品查询（#73）：关键词 + 商品状态筛选写入 URL，游标分页；人工审核队列位于独立的「审核队列」页面。
 */
export function ListingsPage({ search }: { search?: AdminListingsSearch }) {
  const navigate = useNavigate()
  const q = search?.q
  const status = search?.status
  const [draft, setDraft] = useState(q ?? '')
  const [page, setPage] = useState<PageState>({ cursor: null, stack: [] })

  const query = useAdminListings({ q, status, cursor: page.cursor ?? undefined, limit: 20 })
  const body = query.data

  const apply = (patch: Partial<AdminListingsSearch>) => {
    setPage({ cursor: null, stack: [] })
    void navigate({ to: '/admin/listings', search: { q, status, ...patch } })
  }

  const nextPage = () => {
    if (!body?.nextCursor) return
    setPage((prev) => ({ cursor: body.nextCursor, stack: [...prev.stack, prev.cursor] }))
  }
  const prevPage = () => {
    setPage((prev) => {
      const stack = [...prev.stack]
      const previous = stack.pop() ?? null
      return { cursor: previous, stack }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold text-lg">商品查询</h1>
        <div className="flex items-center gap-2">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5">
            <Search className="size-4 text-ink-3" />
            <Input
              className="h-auto w-44 border-0 bg-transparent p-0 text-sm shadow-none"
              maxLength={50}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') apply({ q: draft.trim() || undefined })
              }}
              placeholder="标题 / 描述关键词"
              value={draft}
            />
          </div>
          <Select
            onValueChange={(value) => apply({ status: value === 'all' ? undefined : value })}
            value={status ?? 'all'}
          >
            <SelectTrigger className="h-9 w-28 text-sm">
              {status ? statusLabel(LISTING_STATUS_LABEL, status) : '全部状态'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="ACTIVE">在售</SelectItem>
              <SelectItem value="RESERVED">已预留</SelectItem>
              <SelectItem value="SOLD">已售出</SelectItem>
              <SelectItem value="OFFLINE">已下架</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {query.isPending ? <LoadingState label="正在加载商品…" /> : null}
      {query.isError ? (
        <ErrorState message="商品列表加载失败" onRetry={() => void query.refetch()} />
      ) : null}
      {query.isSuccess && body && body.items.length === 0 ? (
        <EmptyState description="没有符合条件的商品" emoji="📦" />
      ) : null}

      {body && body.items.length > 0 ? (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">商品</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">分类</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">卖家</th>
                <th className="px-3 py-2 font-medium">价格</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {body.items.map((item) => (
                <tr key={item.id} className="hover:bg-surface-2/60">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      {item.coverUrl ? (
                        <img
                          alt=""
                          className="size-9 shrink-0 rounded-md object-cover"
                          src={item.coverUrl}
                        />
                      ) : (
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs text-ink-3">
                          无图
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-medium">{item.title}</p>
                        <p className="mt-0.5 text-xs text-ink-3">
                          {formatDateTime(item.createdAt)}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-2 sm:table-cell">
                    {categoryLabel(item.category)}
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-2 md:table-cell">
                    {item.seller.nickname}
                  </td>
                  <td className="px-3 py-2.5">{formatPrice(item.priceCents)}</td>
                  <td className="px-3 py-2.5">
                    <Badge
                      shape="pill"
                      variant={item.status === 'ACTIVE' ? 'default' : 'secondary'}
                    >
                      {statusLabel(LISTING_STATUS_LABEL, item.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Link
                      className="text-brand"
                      params={{ listingId: item.id }}
                      to="/admin/listings/$listingId"
                    >
                      详情
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <button
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={page.stack.length === 0 || query.isPending}
          onClick={prevPage}
          type="button"
        >
          上一页
        </button>
        <button
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={!body?.nextCursor || query.isPending}
          onClick={nextPage}
          type="button"
        >
          下一页
        </button>
      </div>
    </div>
  )
}
