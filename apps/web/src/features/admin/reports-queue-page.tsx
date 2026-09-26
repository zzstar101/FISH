import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fish/ui/select'
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
import { useAdminReports } from './queries'

export type AdminReportsSearch = {
  status?: string
  targetType?: string
  reason?: string
}

type PageState = { cursor: string | null; stack: (string | null)[] }

/** URL 是筛选来源：筛选变化时同步重挂列表，首帧就丢弃旧游标与上一页栈。 */
export function reportsQueueForSearch(search: AdminReportsSearch) {
  return (
    <ReportsQueuePage
      key={JSON.stringify([
        search.status ?? null,
        search.targetType ?? null,
        search.reason ?? null,
      ])}
      search={search}
    />
  )
}

const STATUSES = ['PENDING', 'HANDLED', 'REJECTED'] as const
const TARGET_TYPES = ['LISTING', 'USER'] as const
const REASONS = [
  'MISLEADING',
  'PROHIBITED',
  'FRAUD',
  'SPAM',
  'HARASSMENT',
  'IMPERSONATION',
  'ABUSE',
  'OTHER',
] as const

/**
 * 举报队列（#73 设计 §4.7 / §6）：状态 / 目标类型 / 原因筛选全部写进 URL（便于复制定位），
 * 筛选一改就重置游标（否则会带着上一组条件的 cursor 去查新条件，第二页直接空）。
 *
 * `reportCount` 来自服务端 `count(*) OVER (PARTITION BY target)`，是同一目标收到的
 * 举报总数，不是当前页有几条——多个人打同一个目标时能在列表里直接看出来。
 */
export function ReportsQueuePage({ search }: { search: AdminReportsSearch }) {
  const navigate = useNavigate()
  const [page, setPage] = useState<PageState>({ cursor: null, stack: [] })

  const query = useAdminReports({
    status: search.status,
    targetType: search.targetType,
    reason: search.reason,
    cursor: page.cursor ?? undefined,
    limit: 20,
  })
  const body = query.data

  const applySearch = (patch: Partial<AdminReportsSearch>) => {
    setPage({ cursor: null, stack: [] })
    void navigate({
      to: '/admin/reports',
      search: {
        status: search.status,
        targetType: search.targetType,
        reason: search.reason,
        ...patch,
      },
    })
  }

  const nextPage = () => {
    if (!body?.nextCursor) return
    setPage((prev) => ({ cursor: body.nextCursor, stack: [...prev.stack, prev.cursor] }))
  }
  const prevPage = () => {
    setPage((prev) => {
      const stack = [...prev.stack]
      const previous = stack.pop() ?? null
      return { cursor: previous, stack }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold text-lg">举报队列</h1>
          <p className="mt-1 text-sm text-ink-3">
            用户提交的举报。处理只写结果与原因，治理动作（下架 / 恢复 / 限制 / 封禁）另有入口。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            onValueChange={(value) => applySearch({ status: value === 'all' ? undefined : value })}
            value={search.status ?? 'all'}
          >
            <SelectTrigger className="h-9 w-28 text-sm">
              {search.status ? statusLabel(REPORT_STATUS_LABEL, search.status) : '全部状态'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabel(REPORT_STATUS_LABEL, status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) =>
              applySearch({ targetType: value === 'all' ? undefined : value })
            }
            value={search.targetType ?? 'all'}
          >
            <SelectTrigger className="h-9 w-28 text-sm">
              {search.targetType
                ? statusLabel(REPORT_TARGET_TYPE_LABEL, search.targetType)
                : '全部对象'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部对象</SelectItem>
              {TARGET_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {statusLabel(REPORT_TARGET_TYPE_LABEL, type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => applySearch({ reason: value === 'all' ? undefined : value })}
            value={search.reason ?? 'all'}
          >
            <SelectTrigger className="h-9 w-28 text-sm">
              {search.reason ? statusLabel(REPORT_REASON_LABEL, search.reason) : '全部原因'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部原因</SelectItem>
              {REASONS.map((reason) => (
                <SelectItem key={reason} value={reason}>
                  {statusLabel(REPORT_REASON_LABEL, reason)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {query.isPending ? <LoadingState label="正在加载举报队列…" /> : null}
      {query.isError ? (
        <ErrorState message="举报队列加载失败" onRetry={() => void query.refetch()} />
      ) : null}
      {query.isSuccess && body && body.items.length === 0 ? (
        <EmptyState description="没有符合条件的举报" emoji="📭" />
      ) : null}

      {body && body.items.length > 0 ? (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">对象</th>
                <th className="px-3 py-2 font-medium">举报人</th>
                <th className="px-3 py-2 font-medium">原因</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">举报数</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">提交时间</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {body.items.map((item) => (
                <tr className="hover:bg-surface-2/60" key={item.report.id}>
                  <td className="px-3 py-2.5">
                    <p className="font-medium">{item.target.label}</p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {statusLabel(REPORT_TARGET_TYPE_LABEL, item.target.targetType)}
                      {item.target.listingStatus
                        ? ` · ${statusLabel(
                            {
                              ACTIVE: '在售',
                              RESERVED: '已预留',
                              SOLD: '已售出',
                              OFFLINE: '已下架',
                            } as Record<string, string>,
                            item.target.listingStatus,
                          )}`
                        : ''}
                    </p>
                  </td>
                  <td className="px-3 py-2.5">{item.reporter.nickname}</td>
                  <td className="px-3 py-2.5 text-ink-2">
                    {statusLabel(REPORT_REASON_LABEL, item.report.reason)}
                    {item.report.detailText ? (
                      <p className="mt-0.5 line-clamp-1 text-xs text-ink-3">
                        {item.report.detailText}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge shape="pill" variant={badgeVariantFor(item.report.status)}>
                      {statusLabel(REPORT_STATUS_LABEL, item.report.status)}
                    </Badge>
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-2 md:table-cell">
                    {item.reportCount}
                  </td>
                  <td className="hidden px-3 py-2.5 text-ink-3 md:table-cell">
                    {formatDateTime(item.report.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Link
                      className="text-brand"
                      params={{ reportId: item.report.id }}
                      to="/admin/reports/$reportId"
                    >
                      {shortId(item.report.id)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <button
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={page.stack.length === 0 || query.isPending}
          onClick={prevPage}
          type="button"
        >
          上一页
        </button>
        <button
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={!body?.nextCursor || query.isPending}
          onClick={nextPage}
          type="button"
        >
          下一页
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
