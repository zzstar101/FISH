import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fish/ui/select'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useState } from 'react'
import {
  AUDIT_ACTION_LABEL,
  AUDIT_TARGET_LABEL,
  formatDateTime,
  shortId,
  statusLabel,
} from './display'
import { useAdminAuditLogs } from './queries'

type PageState = { cursor: string | null; stack: (string | null)[] }

/**
 * 审计日志（#73 设计 §4.6）：只读，默认最新优先；可按动作 / 目标类型筛选。
 * 审计日志不可由后台 UI 删除或修改（应用层不提供更新 / 删除接口）。
 */
export function AuditLogsPage() {
  const [action, setAction] = useState<string | undefined>(undefined)
  const [targetType, setTargetType] = useState<string | undefined>(undefined)
  const [page, setPage] = useState<PageState>({ cursor: null, stack: [] })

  const query = useAdminAuditLogs({
    action,
    targetType,
    cursor: page.cursor ?? undefined,
    limit: 20,
  })
  const body = query.data as { items: AuditEntry[]; nextCursor: string | null } | undefined

  const resetPage = () => setPage({ cursor: null, stack: [] })

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
        <h1 className="font-semibold text-lg">审计日志</h1>
        <div className="flex items-center gap-2">
          <Select
            onValueChange={(value) => {
              setAction(value === 'all' ? undefined : value)
              resetPage()
            }}
            value={action ?? 'all'}
          >
            <SelectTrigger className="h-9 w-32 text-sm">
              {action ? statusLabel(AUDIT_ACTION_LABEL, action) : '全部动作'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部动作</SelectItem>
              <SelectItem value="ADMIN_PROMOTED">提升管理员</SelectItem>
            </SelectContent>
          </Select>
          <Select
            onValueChange={(value) => {
              setTargetType(value === 'all' ? undefined : value)
              resetPage()
            }}
            value={targetType ?? 'all'}
          >
            <SelectTrigger className="h-9 w-32 text-sm">
              {targetType ? statusLabel(AUDIT_TARGET_LABEL, targetType) : '全部目标'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部目标</SelectItem>
              <SelectItem value="USER">用户</SelectItem>
              <SelectItem value="LISTING">商品</SelectItem>
              <SelectItem value="MODERATION_RECORD">审核记录</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {query.isPending ? <LoadingState label="正在加载审计日志…" /> : null}
      {query.isError ? (
        <ErrorState message="审计日志加载失败" onRetry={() => void query.refetch()} />
      ) : null}
      {query.isSuccess && body && body.items.length === 0 ? (
        <EmptyState description="暂无审计日志" emoji="📋" />
      ) : null}

      {body && body.items.length > 0 ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {body.items.map((entry) => (
              <li className="p-4" key={entry.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge shape="pill">{statusLabel(AUDIT_ACTION_LABEL, entry.action)}</Badge>
                  <span className="text-sm text-ink-2">
                    {entry.actor ? `操作者：${entry.actor.nickname}` : '操作者：系统初始化'}
                  </span>
                  <span className="text-xs text-ink-3">
                    目标：{statusLabel(AUDIT_TARGET_LABEL, entry.targetType)}（
                    {shortId(entry.targetId)}）
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-ink-3">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </div>
                {(entry.before !== null && entry.before !== undefined) ||
                (entry.after !== null && entry.after !== undefined) ? (
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-2.5 text-xs text-ink-2">
                    {JSON.stringify({ 变更前: entry.before, 变更后: entry.after }, null, 2)}
                  </pre>
                ) : null}
                {entry.reason ? (
                  <p className="mt-1.5 text-sm text-ink-2">原因：{entry.reason}</p>
                ) : null}
                {entry.requestId ? (
                  <p className="mt-1 text-xs text-ink-3">请求追踪：{entry.requestId}</p>
                ) : null}
              </li>
            ))}
          </ul>
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

type AuditEntry = {
  id: string
  actor: { id: string; nickname: string } | null
  action: string
  targetType: string
  targetId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  requestId: string | null
  createdAt: string
}
