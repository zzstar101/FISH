import type { AdminAuditLogEntry } from '@fish/contracts/admin/schema'
import { AdminAuditActionSchema, AdminAuditTargetTypeSchema } from '@fish/contracts/admin/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useNavigate } from '@tanstack/react-router'
import { DateRangeFilter, FilterChips, ForbiddenInline, LoadMore } from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminAuditLogs } from './admin-queries'
import { cursorSearch, dayRangeSearch, optionalSearch, withoutCursor } from './admin-search'
import { AUDIT_TARGET_TYPE_LABEL, auditActionLabel, formatAdminDateTime } from './admin-view'

export type AuditSearch = {
  actorId?: string
  action?:
    | 'ADMIN_PROMOTED'
    | 'MODERATION_DECISION'
    | 'REPORT_DECISION'
    | 'LISTING_DELISTED'
    | 'LISTING_RESTORED'
    | 'USER_RESTRICTED'
    | 'USER_RESTRICTION_LIFTED'
    | 'USER_BANNED'
    | 'USER_UNBANNED'
  targetType?: 'USER' | 'LISTING' | 'MODERATION_RECORD' | 'REPORT' | 'USER_RESTRICTION'
  targetId?: string
  from?: string
  to?: string
  cursor?: string
}

/** 审计日志（#467 验收「日志查询与分页」）。全部只读；筛选按动作/目标类型/时间段。 */
export function AuditPage({ search }: { search: AuditSearch }) {
  const navigate = useNavigate()
  const range = dayRangeSearch(search.from, search.to)
  const filters = {
    actorId: search.actorId,
    action: search.action,
    targetType: search.targetType,
    targetId: search.targetId,
    createdFrom: range.createdFrom,
    createdTo: range.createdTo,
  }
  const audit = useAdminAuditLogs(filters)

  function update(next: Partial<AuditSearch>) {
    void navigate({ to: '/admin/audit', search: { ...withoutCursor(search), ...next } })
  }

  if (audit.isError) {
    const outcome = adminLoadOutcome(audit.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="审计日志加载失败" onRetry={() => void audit.refetch()} />
  }

  const items = audit.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">审计日志</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          管理操作不可变记录；快照为服务端脱敏后的结果，端上不还原敏感字段。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="动作筛选"
          onChange={(action) => update({ action: action as AuditSearch['action'] })}
          options={[
            { value: 'MODERATION_DECISION', label: '审核决定' },
            { value: 'REPORT_DECISION', label: '举报处理' },
            { value: 'LISTING_DELISTED', label: '下架' },
            { value: 'LISTING_RESTORED', label: '恢复' },
            { value: 'USER_RESTRICTED', label: '限制发布' },
            { value: 'USER_BANNED', label: '封禁' },
            { value: 'USER_RESTRICTION_LIFTED', label: '解除限制' },
          ]}
          value={search.action}
        />
        <FilterChips
          ariaLabel="目标类型筛选"
          onChange={(targetType) => update({ targetType: targetType as AuditSearch['targetType'] })}
          options={[
            { value: 'USER', label: '用户' },
            { value: 'LISTING', label: '商品' },
            { value: 'REPORT', label: '举报' },
            { value: 'MODERATION_RECORD', label: '审核记录' },
          ]}
          value={search.targetType}
        />
        <DateRangeFilter
          fromValue={search.from}
          onCommit={({ from, to }) => update({ from, to })}
          toValue={search.to}
        />
      </div>

      {search.actorId !== undefined || search.targetId !== undefined ? (
        <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-brand text-sm" role="status">
          正在按 ID 过滤
          {search.actorId !== undefined ? `（操作者 ${search.actorId}）` : ''}
          {search.targetId !== undefined ? `（目标 ${search.targetId}）` : ''}，
          <button
            className="font-semibold underline"
            onClick={() => update({ actorId: undefined, targetId: undefined })}
            type="button"
          >
            清除
          </button>
        </p>
      ) : null}

      {audit.isPending ? <LoadingState label="正在加载审计日志…" /> : null}
      {audit.isSuccess && items.length === 0 ? (
        <EmptyState description="换个筛选条件试试" emoji="📜" title="没有匹配的审计记录" />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((entry) => (
            <AuditRow entry={entry} key={entry.id} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={audit.isFetchNextPageError}
        hasNextPage={audit.hasNextPage}
        isFetchingNextPage={audit.isFetchingNextPage}
        onNext={() => void audit.fetchNextPage()}
        onRetry={() => void audit.fetchNextPage()}
      />
    </div>
  )
}

function AuditRow({ entry }: { entry: AdminAuditLogEntry }) {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{auditActionLabel(entry.action)}</Badge>
            <span className="text-ink-2 text-sm">
              {entry.actor === null ? '（操作者已删除）' : entry.actor.nickname}
            </span>
            <span className="text-ink-3 text-xs">
              {AUDIT_TARGET_TYPE_LABEL[entry.targetType] ?? entry.targetType}
              {entry.targetId !== null ? ` ${entry.targetId}` : ''}
            </span>
          </div>
          {entry.reason !== null ? (
            <p className="mt-1 text-ink-2 text-xs">原因：{entry.reason}</p>
          ) : null}
          {entry.after !== null && Object.keys(entry.after).length > 0 ? (
            <p className="mt-0.5 truncate text-ink-3 text-xs">
              after: {JSON.stringify(entry.after)}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 text-ink-3 text-xs">{formatAdminDateTime(entry.createdAt)}</span>
      </div>
    </div>
  )
}

/** validateSearch 共用实现。 */
export function parseAuditSearch(search: Record<string, unknown>): AuditSearch {
  const action = optionalSearch(AdminAuditActionSchema, search.action)
  const targetType = optionalSearch(AdminAuditTargetTypeSchema, search.targetType)
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
    ...(idParam(search.actorId) !== undefined ? { actorId: idParam(search.actorId) } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(targetType !== undefined ? { targetType } : {}),
    ...(idParam(search.targetId) !== undefined ? { targetId: idParam(search.targetId) } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
