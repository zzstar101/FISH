import type { AdminDisputeItem, DisputeStatus, DisputeType } from '@fish/contracts/disputes/schema'
import { DisputeStatusSchema, DisputeTypeSchema } from '@fish/contracts/disputes/schema'
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
import { useAdminDisputes } from './admin-queries'
import {
  cursorSearch,
  dayParam,
  dayRangeSearch,
  optionalSearch,
  trimmedSearch,
  withoutCursor,
} from './admin-search'
import { disputeStatusMeta, disputeTypeLabel, formatAdminDateTime } from './admin-view'

export type DisputesSearch = {
  /** 缺省 = 全部（处理完的争议也要能查历史）。 */
  status?: DisputeStatus
  type?: DisputeType
  q?: string
  from?: string
  to?: string
  cursor?: string
}

/** 争议队列（#465 验收「管理端队列、筛选、详情」）。只读列表 + 状态/类型/关键词/时间段筛选。 */
export function DisputesPage({ search }: { search: DisputesSearch }) {
  const navigate = useNavigate()
  const range = dayRangeSearch(search.from, search.to)
  const filters = {
    status: search.status,
    type: search.type,
    q: search.q,
    createdFrom: range.createdFrom,
    createdTo: range.createdTo,
  }
  const disputes = useAdminDisputes(filters)

  function update(next: Partial<DisputesSearch>) {
    void navigate({ to: '/admin/disputes', search: { ...withoutCursor(search), ...next } })
  }

  if (disputes.isError) {
    const outcome = adminLoadOutcome(disputes.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="争议队列加载失败" onRetry={() => void disputes.refetch()} />
  }

  const items = disputes.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">交易争议</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          处理争议只写结论与原因，不改变成交事实、也不执行处罚；需要下架或封禁请另走治理动作。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="争议状态筛选"
          onChange={(status) => update({ status: status as DisputesSearch['status'] })}
          options={[
            { value: 'PENDING', label: '待处理' },
            { value: 'RESOLVED', label: '已处理' },
            { value: 'WITHDRAWN', label: '已撤回' },
          ]}
          value={search.status}
        />
        <FilterChips
          ariaLabel="争议类型筛选"
          onChange={(type) => update({ type: type as DisputesSearch['type'] })}
          options={[
            { value: 'ITEM_MISMATCH', label: '商品与描述不符' },
            { value: 'NOT_COMPLETED', label: '交易未完成' },
            { value: 'PAYMENT_ISSUE', label: '支付问题' },
            { value: 'OTHER', label: '其他' },
          ]}
          value={search.type}
        />
        <KeywordFilter onCommit={(q) => update({ q })} placeholder="关键词" value={search.q} />
        <DateRangeFilter
          fromValue={search.from}
          onCommit={({ from, to }) => update({ from, to })}
          toValue={search.to}
        />
      </div>

      {disputes.isPending ? <LoadingState label="正在加载争议…" /> : null}
      {disputes.isSuccess && items.length === 0 ? (
        <EmptyState description="换个筛选条件试试" emoji="⚖️" title="没有匹配的争议" />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <DisputeRow item={item} key={item.dispute.id} search={search} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={disputes.isFetchNextPageError}
        hasNextPage={disputes.hasNextPage}
        isFetchingNextPage={disputes.isFetchingNextPage}
        onNext={() => void disputes.fetchNextPage()}
        onRetry={() => void disputes.fetchNextPage()}
      />
    </div>
  )
}

/**
 * 具名导出供静态渲染测试（同 `ModerationRow`）。
 *
 * 行链接**透传队列当前的筛选**，详情页的「← 争议队列」才能原样退回：早先只带
 * `status: item.dispute.status`，于是从「全部」队列点进一条已处理的争议后再返回，
 * URL 会凭空多出用户没选过的 `?status=RESOLVED`，且 `type/q/from/to` 全丢。
 */
export function DisputeRow({ item, search }: { item: AdminDisputeItem; search: DisputesSearch }) {
  const statusMeta = disputeStatusMeta(item.dispute.status)
  const { transaction } = item.dispute
  return (
    <Link
      className="flex items-center gap-4 p-4 transition-colors hover:bg-surface-2/60"
      params={{ disputeId: item.dispute.id }}
      search={withoutCursor(search)}
      to="/admin/disputes/$disputeId"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
          <span className="font-semibold text-sm">
            {disputeTypeLabel(item.dispute.type)}「{transaction.listingTitle}」
          </span>
          <Badge variant="secondary">{formatPrice(transaction.amountCents)}</Badge>
          {item.disputeCount > 1 ? (
            <Badge variant="warn">同交易 {item.disputeCount} 起</Badge>
          ) : null}
        </div>
        <p className="mt-1 truncate text-ink-3 text-xs">
          {item.dispute.initiator.nickname} → {item.dispute.respondent.nickname} · 附件{' '}
          {item.attachmentCount} · 证据 {item.evidenceCount} ·{' '}
          {formatAdminDateTime(item.dispute.createdAt)}
        </p>
      </div>
      <span aria-hidden className="text-ink-3 text-sm">
        ›
      </span>
    </Link>
  )
}

/** validateSearch 共用实现（status / type 缺省 = 全部）。 */
export function parseDisputesSearch(search: Record<string, unknown>): DisputesSearch {
  const status = optionalSearch(DisputeStatusSchema, search.status)
  const type = optionalSearch(DisputeTypeSchema, search.type)
  const q = trimmedSearch(search.q)
  const from = dayParam(search.from)
  const to = dayParam(search.to)
  const cursor = cursorSearch(search.cursor)
  return {
    ...(status !== undefined ? { status } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
