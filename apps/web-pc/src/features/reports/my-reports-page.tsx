import type { Report } from '@fish/contracts/reports/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Loader2 } from 'lucide-react'
import { formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import { REPORT_EMPTY_COPY, REPORT_STATUS_META, reasonLabel } from './meta'
import { useMyReports } from './queries'
import { shortReportId } from './view'

/**
 * 「我的举报」。`/reports` 落在 `__root.tsx` 的 `RequireAuth` 分支里，
 * 因此这里 `me` 必定存在（仍显式收口，避免类型分支散落）。
 */
export function MyReportsPage() {
  const { me } = useAuth()
  if (!me) return null
  return <MyReportsContent key={me.id} />
}

function MyReportsContent() {
  const reports = useMyReports(true)
  const items = reports.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="mx-auto max-w-[980px] space-y-5">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的举报</h1>
          <p className="mt-1.5 text-ink-3 text-sm">你提交过的举报与处理进度。</p>
        </div>
      </div>

      {reports.isPending ? <LoadingState label="正在加载举报记录…" /> : null}
      {reports.isError ? (
        <ErrorState message="举报记录加载失败" onRetry={() => void reports.refetch()} />
      ) : null}

      {reports.isSuccess && items.length === 0 ? (
        <EmptyState
          description={REPORT_EMPTY_COPY.text}
          emoji="🛡️"
          title={REPORT_EMPTY_COPY.title}
        />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 overflow-hidden border border-line p-0">
          <ul className="divide-y divide-line">
            {items.map((report) => (
              <li key={report.id}>
                <ReportRow report={report} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {reports.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            disabled={reports.isFetchingNextPage}
            onClick={() => void reports.fetchNextPage()}
            variant="outline"
          >
            {reports.isFetchingNextPage ? <Loader2 className="size-4 animate-spin" /> : null}
            {reports.isFetchingNextPage ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}

      {reports.isFetchNextPageError ? (
        <p className="text-center text-danger text-xs">加载更多失败，请重试</p>
      ) : null}
    </div>
  )
}

function ReportRow({ report }: { report: Report }) {
  const status = REPORT_STATUS_META[report.status]
  const kind = report.targetType === 'LISTING' ? '商品' : '用户'

  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="font-medium text-sm">
          举报{kind} · {reasonLabel(report.targetType, report.reason)}
        </p>
        <p className="mt-1 truncate text-ink-3 text-xs">
          {formatRelativeTimeAt(report.createdAt)}提交 · 编号 {shortReportId(report.id)}
        </p>
        {report.detailText !== null ? (
          <p className="mt-2 line-clamp-2 text-ink-2 text-xs leading-5">{report.detailText}</p>
        ) : null}
      </div>
      <Badge shape="pill" variant={status.variant}>
        {status.label}
      </Badge>
    </div>
  )
}
