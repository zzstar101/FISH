import type { AdminReportItem } from '@fish/contracts/reports/schema'
import {
  type ReportReason,
  ReportReasonSchema,
  type ReportStatus,
  ReportStatusSchema,
  type ReportTargetType,
  ReportTargetTypeSchema,
} from '@fish/contracts/reports/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { REPORT_REASON_LABEL, REPORT_STATUS_META, reasonLabel } from '../reports/meta'
import { FilterChips, ForbiddenInline, LoadMore } from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminReports } from './admin-queries'
import { cursorSearch, optionalSearch, withoutCursor } from './admin-search'
import { formatAdminDateTime } from './admin-view'

/**
 * URL 上的「全部状态」哨兵。URL-only 状态要区分四个视图（缺省待处理 / 全部 / 三种状态），
 * 而「缺省」已被默认待处理占用，所以「全部」必须显式写在查询串里（`?status=ALL`）；
 * 发给服务端时再还原成 `undefined`（契约 `status` 缺省即全部）。
 */
export const REPORTS_STATUS_ALL = 'ALL' as const

export type ReportsSearch = {
  /** 缺省 = PENDING（待处理队列）；'ALL' = 全状态视图。 */
  status: ReportStatus | typeof REPORTS_STATUS_ALL
  targetType?: ReportTargetType
  reason?: ReportReason
  cursor?: string
}

/** 举报队列（#467 验收「队列、筛选/分页」）。状态筛选缺省待处理，「全部」显式可达。 */
export function ReportsPage({ search }: { search: ReportsSearch }) {
  const navigate = useNavigate()
  const filters = {
    status: search.status === REPORTS_STATUS_ALL ? undefined : search.status,
    targetType: search.targetType,
    reason: search.reason,
  }
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
            update({
              status: status === undefined ? REPORTS_STATUS_ALL : (status as ReportStatus),
            })
          }
          options={[
            { value: 'PENDING', label: '待处理' },
            { value: 'HANDLED', label: '已受理' },
            { value: 'REJECTED', label: '已驳回' },
          ]}
          value={search.status === REPORTS_STATUS_ALL ? undefined : search.status}
        />
        <FilterChips
          ariaLabel="目标类型筛选"
          onChange={(targetType) => update({ targetType: targetType as ReportTargetType })}
          options={[
            { value: 'LISTING', label: '商品' },
            { value: 'USER', label: '用户' },
          ]}
          value={search.targetType}
        />
        <FilterChips
          ariaLabel="举报原因筛选"
          onChange={(reason) => update({ reason: reason as ReportReason })}
          options={ReportReasonSchema.options.map((reason) => ({
            value: reason,
            label: REPORT_REASON_LABEL[reason],
          }))}
          value={search.reason}
        />
      </div>

      {search.reason !== undefined ? (
        <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-brand text-sm" role="status">
          正在按原因过滤（{REPORT_REASON_LABEL[search.reason]}），
          <button
            className="font-semibold underline"
            onClick={() => update({ reason: undefined })}
            type="button"
          >
            清除
          </button>
        </p>
      ) : null}

      {reports.isPending ? <LoadingState label="正在加载举报…" /> : null}
      {reports.isSuccess && items.length === 0 ? (
        <EmptyState
          description={
            search.status === 'PENDING'
              ? '没有待处理的举报。'
              : search.status === REPORTS_STATUS_ALL
                ? '还没有任何举报。'
                : '该状态下没有举报。'
          }
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

/** validateSearch 共用实现（status 缺省 = PENDING；显式 `ALL` = 全状态视图）。 */
export function parseReportsSearch(search: Record<string, unknown>): ReportsSearch {
  const status: ReportsSearch['status'] =
    search.status === REPORTS_STATUS_ALL
      ? REPORTS_STATUS_ALL
      : (optionalSearch(ReportStatusSchema, search.status) ?? 'PENDING')
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
