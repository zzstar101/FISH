import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fish/ui/select'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useId, useState } from 'react'
import { formatPrice } from '../../lib/format'
import { formatDateTime } from './display'
import { useAdminTransactions } from './queries'

const STATUS_LABEL: Record<string, string> = {
  PENDING_MEETUP: '待面交',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

const STATUSES = ['PENDING_MEETUP', 'COMPLETED', 'CANCELLED'] as const
/**
 * 交易查询筛选（#73 治理半场 PR4）。
 *
 * `buyerId` / `sellerId` / `listingId` 是 uuid，不放进表单——它们只从用户详情 /
 * 商品详情的「查看交易」链接带进来（URL-only，与设计 §4 一致）。表单只暴露人能填的
 * 三个维度：状态、关键词、时间段。
 */
export type AdminTransactionsSearch = {
  status?: string
  q?: string
  createdFrom?: string
  createdTo?: string
}

type PageState = { cursor: string | null; stack: (string | null)[] }

/** 本地时区当天 00:00 的 ISO；非法日期返回 null。 */
function startOfDayIso(date: string): string | null {
  const parsed = new Date(`${date}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** 次日本地时区 00:00 的 ISO（服务端左闭右开：`>= from` 且 `< to`）。 */
function nextDayIso(date: string): string | null {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setDate(parsed.getDate() + 1)
  return parsed.toISOString()
}

export function TransactionsPage({
  search,
  buyerId,
  sellerId,
  listingId,
}: {
  search: AdminTransactionsSearch
  buyerId?: string
  sellerId?: string
  listingId?: string
}) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(search.q ?? '')
  const [page, setPage] = useState<PageState>({ cursor: null, stack: [] })
  const createdFromId = useId()
  const createdToId = useId()

  const query = useAdminTransactions({
    status: search.status,
    q: search.q,
    createdFrom: search.createdFrom ? (startOfDayIso(search.createdFrom) ?? undefined) : undefined,
    createdTo: search.createdTo ? (nextDayIso(search.createdTo) ?? undefined) : undefined,
    buyerId,
    sellerId,
    listingId,
    cursor: page.cursor ?? undefined,
    limit: 20,
  })

  // 筛选一变就重置游标：带着上一组条件的 cursor 去查新条件，第二页会直接空
  // （cursor 编码的是旧条件里的「起点行」）。users-page / reports 队列同一取舍。
  // 三个 URL-only 的 id 必须原样带回：validateSearch 从 URL 读它们，navigate 一旦
  // 漏写，查询就从「按买家/卖家/商品」静默扩大成全平台——管理员不会收到任何提示。
  const applySearch = (patch: Partial<AdminTransactionsSearch>) => {
    setPage({ cursor: null, stack: [] })
    void navigate({
      to: '/admin/transactions',
      search: {
        status: search.status,
        q: search.q,
        createdFrom: search.createdFrom,
        createdTo: search.createdTo,
        buyerId,
        sellerId,
        listingId,
        ...patch,
      },
    })
  }

  if (query.isPending) return <LoadingState label="正在加载交易…" />
  if (query.isError)
    return <ErrorState message="交易查询失败" onRetry={() => void query.refetch()} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold text-lg">交易查询</h1>
          <p className="mt-1 text-sm text-ink-3">管理员可查看全平台交易，不提供修改入口。</p>
        </div>
      </div>

      <Card className="flex flex-wrap items-center gap-3 p-3">
        <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5">
          <Search className="size-4 text-ink-3" />
          <Input
            className="h-auto w-44 border-0 bg-transparent p-0 text-sm shadow-none"
            maxLength={50}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applySearch({ q: draft.trim() || undefined })
            }}
            placeholder="商品标题子串"
            value={draft}
          />
        </div>
        <Select
          onValueChange={(value) => applySearch({ status: value === 'all' ? undefined : value })}
          value={search.status ?? 'all'}
        >
          <SelectTrigger className="h-9 w-32 text-sm">
            {search.status ? (STATUS_LABEL[search.status] ?? search.status) : '全部状态'}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABEL[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-ink-2" htmlFor={createdFromId}>
          起始
          <Input
            className="h-9 w-40 text-sm"
            id={createdFromId}
            onChange={(event) => applySearch({ createdFrom: event.target.value || undefined })}
            type="date"
            value={search.createdFrom ?? ''}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2" htmlFor={createdToId}>
          截止
          <Input
            className="h-9 w-40 text-sm"
            id={createdToId}
            onChange={(event) => applySearch({ createdTo: event.target.value || undefined })}
            type="date"
            value={search.createdTo ?? ''}
          />
        </label>
        {buyerId || sellerId || listingId ? (
          <span className="text-sm text-ink-2">
            已按
            {buyerId ? '买家' : sellerId ? '卖家' : '商品'}过滤
          </span>
        ) : null}
      </Card>

      {query.data.items.length === 0 ? (
        <EmptyState description="没有符合条件的交易" emoji="🧾" />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th className="px-3 py-2">商品</th>
                <th className="px-3 py-2">买卖双方</th>
                <th className="px-3 py-2">金额</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">创建时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {query.data.items.map((transaction) => (
                <tr key={transaction.id}>
                  <td className="px-3 py-2.5">
                    <Link
                      className="font-medium hover:text-brand"
                      params={{ listingId: transaction.listingId }}
                      to="/admin/listings/$listingId"
                    >
                      {transaction.listingTitle}
                    </Link>
                    <p className="text-xs text-ink-3">{transaction.id}</p>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">
                    <Link
                      className="hover:text-brand"
                      params={{ userId: transaction.buyer.id }}
                      to="/admin/users/$userId"
                    >
                      {transaction.buyer.nickname}
                    </Link>
                    {' → '}
                    <Link
                      className="hover:text-brand"
                      params={{ userId: transaction.seller.id }}
                      to="/admin/users/$userId"
                    >
                      {transaction.seller.nickname}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{formatPrice(transaction.amountCents)}</td>
                  <td className="px-3 py-2.5">
                    <Badge
                      shape="pill"
                      variant={transaction.status === 'COMPLETED' ? 'default' : 'secondary'}
                    >
                      {STATUS_LABEL[transaction.status] ?? transaction.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-3">
                    {formatDateTime(transaction.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <div className="flex justify-end gap-3">
        <button
          className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={page.stack.length === 0 || query.isFetching}
          onClick={() =>
            setPage((current) => ({
              cursor: current.stack.at(-1) ?? null,
              stack: current.stack.slice(0, -1),
            }))
          }
          type="button"
        >
          上一页
        </button>
        <button
          className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={!query.data.nextCursor || query.isFetching}
          onClick={() =>
            setPage((current) => ({
              cursor: query.data?.nextCursor ?? null,
              stack: [...current.stack, current.cursor],
            }))
          }
          type="button"
        >
          下一页
        </button>
      </div>
    </div>
  )
}
