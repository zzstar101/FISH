import type { AdminTransaction } from '@fish/contracts/admin/schema'
import { ListingIdSchema, UserIdSchema } from '@fish/contracts/system/public-id'
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
 * 三个 ID 筛选与各自的契约 schema（#467 二审 S1）。服务端 `AdminTransactionQuerySchema` 用的是
 * 同一份 `UserIdSchema` / `ListingIdSchema`：形态不对就回 422，而本页 `isError` 是早返回，
 * 会把筛选区连同「清除」一起藏掉——用户只能手改 URL 才能脱困。所以形态校验放在发请求之前。
 */
const ID_FILTERS = {
  buyerId: { label: '买家 ID', prefix: 'usr_', schema: UserIdSchema },
  sellerId: { label: '卖家 ID', prefix: 'usr_', schema: UserIdSchema },
  listingId: { label: '商品 ID', prefix: 'lst_', schema: ListingIdSchema },
} as const

type TransactionIdField = keyof typeof ID_FILTERS

type RejectedTransactionId = {
  field: TransactionIdField
  label: string
  prefix: string
  raw: string
}

type TransactionIdCheck = {
  /** 通过契约 schema 的 ID：只有这些进 filters（即只有这些会发给服务端）。 */
  valid: { buyerId?: string; sellerId?: string; listingId?: string }
  /** 形态不合法的 ID：留在 URL 里原样回显（输入框 + 就地提示），但绝不进 filters。 */
  rejected: RejectedTransactionId[]
}

/**
 * 公开 ID 的形态校验（与契约同一份 schema）。`idParam` 只判非空，所以 `?buyerId=abc` 这种
 * 手输/手改 URL 以前会原样发给服务端。
 */
export function checkTransactionIds(search: TransactionsSearch): TransactionIdCheck {
  const valid: TransactionIdCheck['valid'] = {}
  const rejected: RejectedTransactionId[] = []
  for (const field of Object.keys(ID_FILTERS) as TransactionIdField[]) {
    const { label, prefix, schema } = ID_FILTERS[field]
    const raw = search[field]
    if (raw === undefined || raw === '') continue
    if (schema.safeParse(raw).success) valid[field] = raw
    else rejected.push({ field, label, prefix, raw })
  }
  return { valid, rejected }
}

/**
 * 交易查询（#467 验收「交易：只读查询，暴露契约已有筛选」）。
 * **不新增任何改交易状态能力**——整页无写操作，行点击跳商品详情（后台侧）。
 */
export function TransactionsPage({ search }: { search: TransactionsSearch }) {
  const navigate = useNavigate()
  const range = dayRangeSearch(search.from, search.to)
  const { rejected, valid } = checkTransactionIds(search)
  const filters = {
    q: search.q,
    status: search.status,
    ...valid,
    createdFrom: range.createdFrom,
    createdTo: range.createdTo,
  }
  const transactions = useAdminTransactions(filters)

  function update(next: Partial<TransactionsSearch>) {
    void navigate({ to: '/admin/transactions', search: { ...withoutCursor(search), ...next } })
  }

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
        <KeywordFilter onCommit={(q) => update({ q })} placeholder="关键词" value={search.q} />
        <FilterChips
          ariaLabel="交易状态筛选"
          onChange={(status) => update({ status: status as TransactionsSearch['status'] })}
          options={[
            { value: 'PENDING_MEETUP', label: '待面交' },
            { value: 'COMPLETED', label: '已完成' },
            { value: 'CANCELLED', label: '已取消' },
          ]}
          value={search.status}
        />
        <DateRangeFilter
          fromValue={search.from}
          onCommit={({ from, to }) => update({ from, to })}
          toValue={search.to}
        />
      </div>

      {/*
        契约已有的三个 ID 筛选（#467 §2「暴露契约已有筛选」）：买家/卖家/商品 ID 都是
        TypeID，不适合下拉，按 ID 精确过滤；每个输入自带「筛选」按钮（KeywordFilter 口径）。
      */}
      <div className="flex flex-wrap items-center gap-3">
        <KeywordFilter
          onCommit={(buyerId) => update({ buyerId })}
          placeholder="买家 ID"
          value={search.buyerId}
        />
        <KeywordFilter
          onCommit={(sellerId) => update({ sellerId })}
          placeholder="卖家 ID"
          value={search.sellerId}
        />
        <KeywordFilter
          onCommit={(listingId) => update({ listingId })}
          placeholder="商品 ID"
          value={search.listingId}
        />
      </div>

      {rejected.length > 0 ? (
        <p className="rounded-xl bg-danger-soft px-4 py-2.5 text-danger text-sm" role="alert">
          {rejected
            .map(
              (item) => `${item.label}「${item.raw}」不是规范的公开 ID（应为 ${item.prefix} 开头）`,
            )
            .join('；')}
          ，已忽略该条件、未发给服务端。
          <button
            className="font-semibold underline"
            onClick={() =>
              update({ buyerId: undefined, listingId: undefined, sellerId: undefined })
            }
            type="button"
          >
            清除
          </button>
        </p>
      ) : null}

      {valid.buyerId !== undefined ||
      valid.sellerId !== undefined ||
      valid.listingId !== undefined ? (
        <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-brand text-sm" role="status">
          正在按 ID 过滤
          {valid.buyerId !== undefined ? `（买家 ${valid.buyerId}）` : ''}
          {valid.sellerId !== undefined ? `（卖家 ${valid.sellerId}）` : ''}
          {valid.listingId !== undefined ? `（商品 ${valid.listingId}）` : ''}，
          <button
            className="font-semibold underline"
            onClick={() =>
              update({ buyerId: undefined, listingId: undefined, sellerId: undefined })
            }
            type="button"
          >
            清除
          </button>
        </p>
      ) : null}

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
  // 这里只做「是不是一段非空字符串」：形态校验与回显提示都在页面边界（`checkTransactionIds`），
  // 非法值要留在 URL 里原样回显才能提示用户，而进 filters 的只有通过契约 schema 的那些。
  const idParam = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
  const buyerId = idParam(search.buyerId)
  const sellerId = idParam(search.sellerId)
  const listingId = idParam(search.listingId)
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
    ...(buyerId !== undefined ? { buyerId } : {}),
    ...(sellerId !== undefined ? { sellerId } : {}),
    ...(listingId !== undefined ? { listingId } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
