import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useState } from 'react'
import { formatPrice } from '../../lib/format'
import { formatDateTime } from './display'
import { useAdminTransactions } from './queries'

const STATUS_LABEL: Record<string, string> = {
  PENDING_MEETUP: '待面交',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

export function TransactionsPage() {
  const [status, setStatus] = useState<string | undefined>()
  const [page, setPage] = useState<{ cursor?: string; stack: (string | undefined)[] }>({
    stack: [],
  })
  const query = useAdminTransactions({ status, cursor: page.cursor, limit: 20 })
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
        <select
          className="h-9 rounded-lg border border-line bg-surface px-2 text-sm"
          onChange={(event) => {
            setStatus(event.target.value || undefined)
            setPage({ stack: [] })
          }}
          value={status ?? ''}
        >
          <option value="">全部状态</option>
          <option value="PENDING_MEETUP">待面交</option>
          <option value="COMPLETED">已完成</option>
          <option value="CANCELLED">已取消</option>
        </select>
      </div>
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
                    <p className="font-medium">{transaction.listingTitle}</p>
                    <p className="text-xs text-ink-3">{transaction.id}</p>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">
                    {transaction.buyer.nickname} → {transaction.seller.nickname}
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
              cursor: current.stack.at(-1),
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
              cursor: query.data.nextCursor ?? undefined,
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
