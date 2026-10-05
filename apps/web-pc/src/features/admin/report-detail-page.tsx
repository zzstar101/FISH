import type { AdminReportDetail } from '@fish/contracts/reports/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { REPORT_STATUS_META, reasonLabel } from '../reports/meta'
import { adminLoadOutcome, reportHandleError } from './admin-messages'
import { useAdminReportDetail, useReportHandle } from './admin-queries'
import { formatAdminDateTime, listingStatusMeta, moderationStatusMeta } from './admin-view'
import { ReportHandleDialog } from './report-handle-dialog'

/**
 * 举报详情（#467 验收「详情、处理结果」）：举报 + 举报人 + 目标摘要（含商品当前状态，
 * 帮助判断是否还要下架）+ 同目标其它未决举报。处理只写结果，不触发治理。
 */
export function ReportDetailPage({ reportId }: { reportId: string }) {
  const detail = useAdminReportDetail(reportId)

  if (detail.isPending) return <LoadingState label="正在加载举报详情…" />
  if (detail.isError) {
    const outcome = adminLoadOutcome(detail.error)
    return (
      <ErrorState
        message={outcome.kind === 'error' ? outcome.message : '举报详情加载失败'}
        onRetry={() => void detail.refetch()}
      />
    )
  }

  return <ReportDetailView detail={detail.data} reportId={reportId} />
}

function ReportDetailView({ detail, reportId }: { detail: AdminReportDetail; reportId: string }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const handle = useReportHandle(reportId)

  const { item } = detail
  const statusMeta = REPORT_STATUS_META[item.report.status]
  const isListingTarget = item.target.targetType === 'LISTING'
  const targetUrl =
    item.target.targetType === 'LISTING'
      ? `/admin/listings/${item.target.targetId}`
      : `/admin/users/${item.target.targetId}`

  async function submit(input: { result: 'HANDLED' | 'REJECTED'; reason: string }) {
    setDialogError(null)
    try {
      await handle.mutateAsync(input)
      setDialogOpen(false)
    } catch (error) {
      const outcome = reportHandleError(error)
      if (outcome.conflict) {
        setDialogOpen(false)
        setConflict(true)
      } else {
        setDialogError(outcome.message)
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            className="text-ink-3 text-sm hover:text-brand"
            search={{ status: 'PENDING' }}
            to="/admin/reports"
          >
            ← 举报队列
          </Link>
          <h1 className="mt-1 font-semibold text-[26px] tracking-[-0.03em]">
            举报：{isListingTarget ? '商品' : '用户'}「{item.target.label}」
          </h1>
          <p className="mt-1.5 flex items-center gap-2 text-ink-3 text-sm">
            <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
            <Badge variant="secondary">
              {reasonLabel(item.target.targetType, item.report.reason)}
            </Badge>
            {item.reportCount > 1 ? (
              <Badge variant="warn">共 {item.reportCount} 人举报</Badge>
            ) : null}
          </p>
        </div>
        {item.report.status === 'PENDING' && !conflict ? (
          <Button
            onClick={() => {
              setDialogError(null)
              setDialogOpen(true)
            }}
          >
            处理举报
          </Button>
        ) : null}
      </div>

      {conflict ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          该举报已被其他管理员处理，列表已刷新。
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">举报内容</h2>
          <p className="text-sm">{item.report.detailText ?? '无补充说明'}</p>
          <p className="text-ink-3 text-xs">
            举报人 {item.reporter.nickname} · 提交于 {formatAdminDateTime(item.report.createdAt)}
            {item.report.handledAt !== null
              ? ` · 处理于 ${formatAdminDateTime(item.report.handledAt)}`
              : ''}
          </p>
          {item.report.handlingReason !== null ? (
            <div className="rounded-xl bg-surface-2 p-3">
              <p className="font-medium text-sm">处理结果</p>
              <p className="mt-1 text-ink-2 text-sm">{item.report.handlingReason}</p>
              {item.report.handledBy !== null ? (
                <p className="mt-1 text-ink-3 text-xs">处理人 {item.report.handledBy.nickname}</p>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">被举报目标</h2>
          <p className="text-sm">
            {isListingTarget ? '商品' : '用户'}「{item.target.label}」
          </p>
          {isListingTarget && item.target.listingStatus !== null ? (
            <p className="flex items-center gap-2 text-ink-2 text-sm">
              当前状态：
              <Badge variant={listingStatusMeta(item.target.listingStatus).variant}>
                {listingStatusMeta(item.target.listingStatus).label}
              </Badge>
              {item.target.moderationStatus !== null ? (
                <Badge variant={moderationStatusMeta(item.target.moderationStatus).variant}>
                  {moderationStatusMeta(item.target.moderationStatus).label}
                </Badge>
              ) : null}
            </p>
          ) : null}
          <Link className="text-brand text-sm hover:underline" to={targetUrl}>
            {isListingTarget ? '查看商品详情 →' : '查看用户详情（可执行治理）→'}
          </Link>

          {detail.related.length > 0 ? (
            <div>
              <p className="mt-2 font-medium text-sm">同目标的其它未决举报</p>
              <ul className="mt-1.5 space-y-1.5">
                {detail.related.map((related) => (
                  <li className="text-ink-2 text-xs" key={related.id}>
                    {reasonLabel(item.target.targetType, related.reason)} ·{' '}
                    {formatAdminDateTime(related.createdAt)} ·{' '}
                    <Link
                      className="text-brand hover:underline"
                      params={{ reportId: related.id }}
                      search={{ status: 'PENDING' }}
                      to="/admin/reports/$reportId"
                    >
                      查看
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>

      {dialogOpen ? (
        <ReportHandleDialog
          errorMessage={dialogError}
          onClose={() => setDialogOpen(false)}
          onSubmit={(input) => void submit(input)}
          pending={handle.isPending}
          targetLabel={item.target.label}
        />
      ) : null}
    </div>
  )
}
