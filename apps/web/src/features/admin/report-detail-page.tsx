import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import {
  formatDateTime,
  REPORT_REASON_LABEL,
  REPORT_STATUS_LABEL,
  REPORT_STATUS_TONE,
  REPORT_TARGET_TYPE_LABEL,
  shortId,
  statusLabel,
} from './display'
import { useAdminReport, useHandleAdminReport } from './queries'

/**
 * 举报详情与处理（#73 设计 §4.7 / §6）。
 *
 * 处理与治理刻意分开（grill Q9）：这里只写「受理 / 驳回 + 原因」，不改商品或用户状态。
 * 下架、恢复、限制发布、封禁都有各自的 Admin 端点，可以由本页引导跳转，但不在这里触发。
 */
export function ReportDetailPage({ reportId }: { reportId: string }) {
  const detail = useAdminReport(reportId)
  const handle = useHandleAdminReport(reportId)
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const [selected, setSelected] = useState<'HANDLED' | 'REJECTED' | null>(null)

  if (detail.isPending) return <LoadingState label="正在加载举报详情…" />
  if (detail.isError)
    return <ErrorState message="举报详情加载失败" onRetry={() => void detail.refetch()} />
  const data = detail.data
  const { item, related } = data
  const alreadyHandled = item.report.status !== 'PENDING'

  const submit = () => {
    if (!selected || !reason.trim() || handle.isPending) return
    if (!window.confirm(selected === 'HANDLED' ? '确认受理这条举报吗？' : '确认驳回这条举报吗？'))
      return
    handle.mutate({ result: selected, reason: reason.trim() })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link className="text-sm text-ink-3 hover:text-ink" to="/admin/reports">
          ← 返回举报队列
        </Link>
        <span className="text-xs text-ink-3">举报编号 {shortId(item.report.id)}</span>
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-semibold text-lg">
              {statusLabel(REPORT_TARGET_TYPE_LABEL, item.target.targetType)}：{item.target.label}
            </h1>
            <p className="mt-1 text-sm text-ink-3">举报人：{item.reporter.nickname}</p>
            <p className="mt-1 text-sm text-ink-3">
              提交时间：{formatDateTime(item.report.createdAt)}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <Badge shape="pill" variant={badgeVariantFor(item.report.status)}>
              {statusLabel(REPORT_STATUS_LABEL, item.report.status)}
            </Badge>
            <Badge shape="pill" variant="secondary">
              原因：{statusLabel(REPORT_REASON_LABEL, item.report.reason)}
            </Badge>
          </div>
        </div>
        <div className="rounded-lg bg-surface-2 p-3 text-sm text-ink-2">
          {item.report.detailText ?? '举报人未填写补充说明'}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
          <span>同一目标共收到 {item.reportCount} 条举报</span>
          {item.target.listingStatus ? (
            <span>
              商品状态：
              {statusLabel(
                {
                  ACTIVE: '在售',
                  RESERVED: '已预留',
                  SOLD: '已售出',
                  OFFLINE: '已下架',
                } as Record<string, string>,
                item.target.listingStatus,
              )}
            </span>
          ) : null}
          {item.target.moderationStatus ? (
            <span>审核状态：{item.target.moderationStatus}</span>
          ) : null}
          <span className="font-mono">{shortId(item.target.targetId)}</span>
        </div>
        {item.target.targetType === 'LISTING' && item.target.listingStatus === null ? (
          <p className="text-sm text-ink-3">商品已不存在，无法从详情执行治理动作。</p>
        ) : item.target.targetType === 'LISTING' ? (
          <Link
            className="inline-flex rounded-lg border border-brand px-3 py-2 text-sm font-medium text-brand hover:bg-brand/5"
            params={{ listingId: item.target.targetId }}
            search={{ sourceReportId: item.report.id }}
            to="/admin/listings/$listingId"
          >
            前往商品详情 · 关联本条举报执行治理 →
          </Link>
        ) : (
          <Link
            className="inline-flex rounded-lg border border-brand px-3 py-2 text-sm font-medium text-brand hover:bg-brand/5"
            params={{ userId: item.target.targetId }}
            search={{ sourceReportId: item.report.id }}
            to="/admin/users/$userId"
          >
            前往用户详情 · 关联本条举报执行治理 →
          </Link>
        )}
      </Card>

      {related.length > 0 ? (
        <Card className="p-4">
          <h2 className="font-semibold">同目标的其它未决举报（{related.length}）</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {related.map((entry) => (
              <li className="flex flex-wrap items-center gap-2 py-2" key={entry.id}>
                <Badge shape="pill" variant="secondary">
                  {statusLabel(REPORT_REASON_LABEL, entry.reason)}
                </Badge>
                <span className="text-ink-2">{entry.detailText ?? '无补充说明'}</span>
                <span className="ml-auto shrink-0 text-xs text-ink-3">
                  {formatDateTime(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {alreadyHandled ? (
        <Card className="p-4">
          <h2 className="font-semibold">处理结果</h2>
          <p className="mt-2 text-sm">
            {item.report.status === 'HANDLED' ? '受理' : '驳回'} · 处理人：
            {item.report.handledBy?.nickname ?? '未知'} · {formatDateTime(item.report.handledAt)}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">
            原因：{item.report.handlingReason ?? '（未填写）'}
          </p>
        </Card>
      ) : (
        <Card className="space-y-3 p-4">
          <div>
            <h2 className="font-semibold">处理举报</h2>
            <p className="mt-1 text-sm text-ink-3">
              只记录处理结果与原因，不会改动商品或用户状态。需要下架、限制发布或封禁时， 请到商品 /
              用户详情页执行对应的治理动作，并关联本条举报作为处罚来源。
            </p>
          </div>
          <textarea
            className="min-h-24 w-full rounded-lg border border-line bg-surface p-2 text-sm outline-none focus:border-brand"
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="请填写处理原因（必填，最多 500 字）"
            value={reason}
          />
          <div className="flex flex-wrap gap-2">
            <button
              className={`rounded-lg px-3 py-1.5 text-sm text-white ${selected === 'HANDLED' ? 'bg-green-700' : 'bg-green-600/80'}`}
              onClick={() => setSelected('HANDLED')}
              type="button"
            >
              受理
            </button>
            <button
              className={`rounded-lg px-3 py-1.5 text-sm text-white ${selected === 'REJECTED' ? 'bg-red-700' : 'bg-red-600/80'}`}
              onClick={() => setSelected('REJECTED')}
              type="button"
            >
              驳回
            </button>
            <button
              className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={!selected || !reason.trim() || handle.isPending}
              onClick={submit}
              type="button"
            >
              {handle.isPending ? '提交中…' : '确认提交'}
            </button>
          </div>
          {handle.isError ? (
            <p className="text-sm text-red-600">
              提交失败：{handle.error.message}（可能是其他管理员已处理，队列已刷新）
            </p>
          ) : null}
        </Card>
      )}

      {related.length === 0 && item.reportCount === 1 ? (
        <EmptyState description="该目标只有这一条举报" emoji="📄" />
      ) : null}

      <div className="flex justify-end">
        <button
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm"
          onClick={() => void navigate({ to: '/admin/reports' })}
          type="button"
        >
          返回队列
        </button>
      </div>
    </div>
  )
}

function badgeVariantFor(status: string): 'default' | 'secondary' {
  const tone = REPORT_STATUS_TONE[status]
  if (tone === 'warning') return 'secondary'
  if (tone === 'success') return 'default'
  return 'secondary'
}
