import type { AdminTransaction } from '@fish/contracts/admin/schema'
import { transactionStatusSchema } from '@fish/contracts/transactions/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { formatPrice } from '../../lib/format'
import {
  DateRangeFilter,
  FilterChips,
  ForbiddenInline,
  KeywordFilter,
  LoadMore,
} from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminTransactions } from './admin-queries'
import {
  cursorSearch,
  dayRangeSearch,
  optionalSearch,
  trimmedSearch,
  withoutCursor,
} from './admin-search'
import { formatAdminDateTime, transactionStatusMeta } from './admin-view'

export type TransactionsSearch = {
  q?: string
  status?: 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'
  buyerId?: string
  sellerId?: string
  listingId?: string
  from?: string
  to?: string
  cursor?: string
}

/**
 * 交易查询（#467 验收「交易：只读查询，暴露契约已有筛选」）。
 * **不新增任何改交易状态能力**——整页无写操作，行点击跳商品详情（后台侧）。
 */
export function TransactionsPage({ search }: { search: TransactionsSearch }) {
  const navigate = useNavigate()
  const range = dayRangeSearch(search.from, search.to)
  const filters = {
    q: search.q,
    status: search.status,
    buyerId: search.buyerId,
    sellerId: search.sellerId,
    listingId: search.listingId,
    createdFrom: range.createdFrom,
    createdTo: range.createdTo,
  }
  const transactions = useAdminTransactions(filters)

  if (transactions.isError) {
    const outcome = adminLoadOutcome(transactions.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="交易列表加载失败" onRetry={() => void transactions.refetch()} />
  }

  const items = transactions.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">交易</h1>
        <p className="mt-1.5 text-ink-3 text-sm">只读查询；后台不提供改交易状态的入口。</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <KeywordFilter onCommit={(q) => update(q)} placeholder="关键词" value={search.q} />
        <FilterChips
          ariaLabel="交易状态筛选"
          onChange={(status) =>
            void navigate({
              to: '/admin/transactions',
              search: { ...withoutCursor(search), status: status as TransactionsSearch['status'] },
            })
          }
          options={[
            { value: 'PENDING_MEETUP', label: '待面交' },
            { value: 'COMPLETED', label: '已完成' },
            { value: 'CANCELLED', label: '已取消' },
          ]}
          value={search.status}
        />
        <DateRangeFilter
          fromValue={search.from}
          onCommit={({ from, to }) =>
            void navigate({
              to: '/admin/transactions',
              search: { ...withoutCursor(search), from, to },
            })
          }
          toValue={search.to}
        />
      </div>

      {transactions.isPending ? <LoadingState label="正在加载交易…" /> : null}
      {transactions.isSuccess && items.length === 0 ? (
        <EmptyState description="换个筛选条件试试" emoji="🧾" title="没有匹配的交易" />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <TransactionRow key={item.id} transaction={item} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={transactions.isFetchNextPageError}
        hasNextPage={transactions.hasNextPage}
        isFetchingNextPage={transactions.isFetchingNextPage}
        onNext={() => void transactions.fetchNextPage()}
        onRetry={() => void transactions.fetchNextPage()}
      />
    </div>
  )

  function update(q: string | undefined) {
    void navigate({ to: '/admin/transactions', search: { ...withoutCursor(search), q } })
  }
}

function TransactionRow({ transaction }: { transaction: AdminTransaction }) {
  const statusMeta = transactionStatusMeta(transaction.status)
  return (
    <Link
      className="block p-4 transition-colors hover:bg-surface-2/60"
      params={{ listingId: transaction.listingId }}
      to="/admin/listings/$listingId"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-sm">{transaction.listingTitle}</span>
            <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
          </div>
          <p className="mt-1 text-ink-3 text-xs">
            {transaction.id} · 买家 {transaction.buyer.nickname} → 卖家{' '}
            {transaction.seller.nickname}
          </p>
          <p className="mt-0.5 text-ink-3 text-xs">
            创建 {formatAdminDateTime(transaction.createdAt)}
            {transaction.completedAt !== null
              ? ` · 完成 ${formatAdminDateTime(transaction.completedAt)}`
              : ''}
            {transaction.cancelledAt !== null
              ? ` · 取消 ${formatAdminDateTime(transaction.cancelledAt)}`
              : ''}
          </p>
        </div>
        <span className="shrink-0 font-semibold">{formatPrice(transaction.amountCents)}</span>
      </div>
    </Link>
  )
}

/** validateSearch 共用实现。 */
export function parseTransactionsSearch(search: Record<string, unknown>): TransactionsSearch {
  const status = optionalSearch(transactionStatusSchema, search.status)
  const q = trimmedSearch(search.q)
  const idParam = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
  const from =
    typeof search.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.from)
      ? search.from
      : undefined
  const to =
    typeof search.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.to) ? search.to : undefined
  const cursor = cursorSearch(search.cursor)
  return {
    ...(q !== undefined ? { q } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(idParam(search.buyerId) !== undefined ? { buyerId: idParam(search.buyerId) } : {}),
    ...(idParam(search.sellerId) !== undefined ? { sellerId: idParam(search.sellerId) } : {}),
    ...(idParam(search.listingId) !== undefined ? { listingId: idParam(search.listingId) } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
