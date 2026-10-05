import type { AdminReportItem } from '@fish/contracts/reports/schema'
import {
  ReportReasonSchema,
  ReportStatusSchema,
  ReportTargetTypeSchema,
} from '@fish/contracts/reports/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { REPORT_STATUS_META, reasonLabel } from '../reports/meta'
import { FilterChips, ForbiddenInline, LoadMore } from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminReports } from './admin-queries'
import { cursorSearch, optionalSearch, withoutCursor } from './admin-search'
import { formatAdminDateTime } from './admin-view'

export type ReportsSearch = {
  /** 缺省 = PENDING（契约：队列页默认传 PENDING；「全部」不在本页语义里）。 */
  status: 'PENDING' | 'HANDLED' | 'REJECTED'
  targetType?: 'LISTING' | 'USER'
  reason?:
    | 'MISLEADING'
    | 'PROHIBITED'
    | 'FRAUD'
    | 'SPAM'
    | 'HARASSMENT'
    | 'IMPERSONATION'
    | 'ABUSE'
    | 'OTHER'
  cursor?: string
}

/** 举报队列（#467 验收「队列、筛选/分页」）。状态筛选缺省待处理。 */
export function ReportsPage({ search }: { search: ReportsSearch }) {
  const navigate = useNavigate()
  const filters = { status: search.status, targetType: search.targetType, reason: search.reason }
  const reports = useAdminReports(filters)

  function update(next: Partial<ReportsSearch>) {
    void navigate({ to: '/admin/reports', search: { ...withoutCursor(search), ...next } })
  }

  if (reports.isError) {
    const outcome = adminLoadOutcome(reports.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="举报队列加载失败" onRetry={() => void reports.refetch()} />
  }

  const items = reports.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">举报</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          处理举报只写结果，不自动执行处罚；下架/封禁走治理端点并可回链举报单。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="举报状态筛选"
          onChange={(status) =>
            update({ status: (status ?? 'PENDING') as ReportsSearch['status'] })
          }
          options={[
            { value: 'PENDING', label: '待处理' },
            { value: 'HANDLED', label: '已受理' },
            { value: 'REJECTED', label: '已驳回' },
          ]}
          value={search.status}
        />
        <FilterChips
          ariaLabel="目标类型筛选"
          onChange={(targetType) =>
            update({ targetType: targetType as ReportsSearch['targetType'] })
          }
          options={[
            { value: 'LISTING', label: '商品' },
            { value: 'USER', label: '用户' },
          ]}
          value={search.targetType}
        />
      </div>

      {reports.isPending ? <LoadingState label="正在加载举报…" /> : null}
      {reports.isSuccess && items.length === 0 ? (
        <EmptyState
          description={search.status === 'PENDING' ? '没有待处理的举报。' : '该状态下没有举报。'}
          emoji="📭"
          title="队列为空"
        />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <ReportRow item={item} key={item.report.id} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={reports.isFetchNextPageError}
        hasNextPage={reports.hasNextPage}
        isFetchingNextPage={reports.isFetchingNextPage}
        onNext={() => void reports.fetchNextPage()}
        onRetry={() => void reports.fetchNextPage()}
      />
    </div>
  )
}

function ReportRow({ item }: { item: AdminReportItem }) {
  const statusMeta = REPORT_STATUS_META[item.report.status]
  const targetLabel = item.target.targetType === 'LISTING' ? '商品' : '用户'
  return (
    <Link
      className="flex items-center gap-4 p-4 transition-colors hover:bg-surface-2/60"
      params={{ reportId: item.report.id }}
      search={{ status: item.report.status }}
      to="/admin/reports/$reportId"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
          <span className="font-semibold text-sm">
            {targetLabel}「{item.target.label}」
          </span>
          <Badge variant="secondary">
            {reasonLabel(item.target.targetType, item.report.reason)}
          </Badge>
          {item.reportCount > 1 ? <Badge variant="warn">{item.reportCount} 人举报</Badge> : null}
        </div>
        <p className="mt-1 truncate text-ink-3 text-xs">
          {item.report.detailText ?? '无补充说明'} · 举报人 {item.reporter.nickname} ·{' '}
          {formatAdminDateTime(item.report.createdAt)}
        </p>
      </div>
      <span aria-hidden className="text-ink-3 text-sm">
        ›
      </span>
    </Link>
  )
}

/** validateSearch 共用实现（status 缺省 = PENDING）。 */
export function parseReportsSearch(search: Record<string, unknown>): ReportsSearch {
  const status = optionalSearch(ReportStatusSchema, search.status) ?? 'PENDING'
  const targetType = optionalSearch(ReportTargetTypeSchema, search.targetType)
  const reason = optionalSearch(ReportReasonSchema, search.reason)
  const cursor = cursorSearch(search.cursor)
  return {
    status,
    ...(targetType !== undefined ? { targetType } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
