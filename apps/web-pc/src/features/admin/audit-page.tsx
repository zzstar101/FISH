import type {
  AdminAuditAction,
  AdminAuditLogEntry,
  AdminAuditTargetType,
} from '@fish/contracts/admin/schema'
import {
  AdminAuditActionSchema,
  AdminAuditTargetIdSchema,
  AdminAuditTargetTypeSchema,
} from '@fish/contracts/admin/schema'
import {
  ListingIdSchema,
  ModerationRecordIdSchema,
  ReportIdSchema,
  UserIdSchema,
  UserRestrictionIdSchema,
} from '@fish/contracts/system/public-id'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useNavigate } from '@tanstack/react-router'
import { DateRangeFilter, FilterChips, ForbiddenInline, LoadMore } from './admin-filter'
import {
  checkPublicIds,
  type PublicIdCheck,
  type PublicIdSpec,
  RejectedIdNotice,
} from './admin-id-guard'
import { adminLoadOutcome } from './admin-messages'
import { useAdminAuditLogs } from './admin-queries'
import { cursorSearch, dayRangeSearch, optionalSearch, withoutCursor } from './admin-search'
import {
  AUDIT_TARGET_TYPE_LABEL,
  auditActionLabel,
  auditActionOptions,
  auditTargetTypeOptions,
  formatAdminDateTime,
} from './admin-view'

export type AuditSearch = {
  actorId?: string
  action?: AdminAuditAction
  targetType?: AdminAuditTargetType
  targetId?: string
  from?: string
  to?: string
  cursor?: string
}

/**
 * 两个 ID 筛选的形态守卫（#467 五审 P0）：服务端 `AdminAuditLogsQuerySchema` 用
 * `UserIdSchema` / `AdminAuditTargetIdSchema`，形态不对回 422，而本页 `isError` 是早返回，
 * 会把筛选区连同「清除」一起藏掉。目标 ID 的前缀随 `targetType` 变——服务端还会用
 * `auditTargetMatches` 校验两者匹配，所以这里也按所选类型收口（没选类型时接受任一公开 ID）。
 */
const AUDIT_ID_FILTERS: Record<'actorId' | 'targetId', PublicIdSpec> = {
  actorId: { label: '操作者 ID', prefix: 'usr_', schema: UserIdSchema },
  targetId: {
    label: '目标 ID',
    prefix: 'usr_ / lst_ / mdr_ / rpt_ / rst_',
    schema: AdminAuditTargetIdSchema,
  },
}

const AUDIT_TARGET_ID_SPECS = {
  USER: { label: '目标 ID', prefix: 'usr_', schema: UserIdSchema },
  LISTING: { label: '目标 ID', prefix: 'lst_', schema: ListingIdSchema },
  MODERATION_RECORD: { label: '目标 ID', prefix: 'mdr_', schema: ModerationRecordIdSchema },
  REPORT: { label: '目标 ID', prefix: 'rpt_', schema: ReportIdSchema },
  USER_RESTRICTION: { label: '目标 ID', prefix: 'rst_', schema: UserRestrictionIdSchema },
} as const satisfies Record<AdminAuditTargetType, PublicIdSpec>

type AuditIdField = keyof typeof AUDIT_ID_FILTERS

/** 只有形态合法的 actorId / targetId 会进 filters（即发给服务端）。 */
export function checkAuditIds(search: AuditSearch): PublicIdCheck<AuditIdField> {
  const specs: Record<AuditIdField, PublicIdSpec> = {
    actorId: AUDIT_ID_FILTERS.actorId,
    targetId:
      search.targetType === undefined
        ? AUDIT_ID_FILTERS.targetId
        : AUDIT_TARGET_ID_SPECS[search.targetType],
  }
  return checkPublicIds(specs, search)
}

/** 审计日志（#467 验收「日志查询与分页」）。全部只读；筛选按动作/目标类型/时间段。 */
export function AuditPage({ search }: { search: AuditSearch }) {
  const navigate = useNavigate()
  const range = dayRangeSearch(search.from, search.to)
  const { rejected, valid } = checkAuditIds(search)
  const filters = {
    actorId: valid.actorId,
    action: search.action,
    targetType: search.targetType,
    targetId: valid.targetId,
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

      {/*
        两个 chip 组都从契约枚举派生（#467 五审 P1）：以前是手写子集，漏掉了
        ADMIN_PROMOTED / USER_UNBANNED / USER_RESTRICTION，用户在界面上筛不到这些动作。
      */}
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="动作筛选"
          onChange={(action) => update({ action })}
          options={auditActionOptions()}
          value={search.action}
        />
        <FilterChips
          ariaLabel="目标类型筛选"
          onChange={(targetType) => update({ targetType })}
          options={auditTargetTypeOptions()}
          value={search.targetType}
        />
        <DateRangeFilter
          fromValue={search.from}
          onCommit={({ from, to }) => update({ from, to })}
          toValue={search.to}
        />
      </div>

      <RejectedIdNotice
        items={rejected}
        onClear={() => update({ actorId: undefined, targetId: undefined })}
      />

      {valid.actorId !== undefined || valid.targetId !== undefined ? (
        <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-brand text-sm" role="status">
          正在按 ID 过滤
          {valid.actorId !== undefined ? `（操作者 ${valid.actorId}）` : ''}
          {valid.targetId !== undefined ? `（目标 ${valid.targetId}）` : ''}，
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
              {AUDIT_TARGET_TYPE_LABEL[entry.targetType]}
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
