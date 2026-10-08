import {
  type AdminFeedbackItem,
  type FeedbackStatus,
  FeedbackStatusSchema,
  type FeedbackType,
  FeedbackTypeSchema,
} from '@fish/contracts/feedback/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { FEEDBACK_STATUS_META, FEEDBACK_TYPE_LABEL } from '../feedback/meta'
import { FilterChips, ForbiddenInline, LoadMore } from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminFeedback } from './admin-queries'
import { cursorSearch, optionalSearch, withoutCursor } from './admin-search'
import { formatAdminDateTime } from './admin-view'

/** URL 上的「全部状态」哨兵（与举报队列同口径：缺省 = 待处理，全部要显式写 `?status=ALL`）。 */
export const FEEDBACK_STATUS_ALL = 'ALL' as const

export type FeedbackSearch = {
  status: FeedbackStatus | typeof FEEDBACK_STATUS_ALL
  type?: FeedbackType
  cursor?: string
}

/** 意见反馈队列（#463）：状态 / 类型筛选 + 游标分页。 */
export function FeedbackQueuePage({ search }: { search: FeedbackSearch }) {
  const navigate = useNavigate()
  const filters = {
    status: search.status === FEEDBACK_STATUS_ALL ? undefined : search.status,
    type: search.type,
  }
  const feedback = useAdminFeedback(filters)

  function update(next: Partial<FeedbackSearch>) {
    void navigate({ to: '/admin/feedback', search: { ...withoutCursor(search), ...next } })
  }

  if (feedback.isError) {
    const outcome = adminLoadOutcome(feedback.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="反馈队列加载失败" onRetry={() => void feedback.refetch()} />
  }

  const items = feedback.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">意见反馈</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          回复会展示给用户；内部备注只写审计。处理反馈不触发任何治理动作。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="反馈状态筛选"
          onChange={(status) =>
            update({
              status: status === undefined ? FEEDBACK_STATUS_ALL : (status as FeedbackStatus),
            })
          }
          options={FeedbackStatusSchema.options.map((status) => ({
            value: status,
            label: FEEDBACK_STATUS_META[status].label,
          }))}
          value={search.status === FEEDBACK_STATUS_ALL ? undefined : search.status}
        />
        <FilterChips
          ariaLabel="反馈类型筛选"
          onChange={(type) => update({ type: type as FeedbackType })}
          options={FeedbackTypeSchema.options.map((type) => ({
            value: type,
            label: FEEDBACK_TYPE_LABEL[type],
          }))}
          value={search.type}
        />
      </div>

      {feedback.isPending ? <LoadingState label="正在加载反馈…" /> : null}
      {feedback.isSuccess && items.length === 0 ? (
        <EmptyState
          description={search.status === 'PENDING' ? '没有待处理的反馈。' : '该条件下没有反馈。'}
          emoji="📭"
          title="队列为空"
        />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <FeedbackQueueRow item={item} key={item.feedback.id} search={search} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={feedback.isFetchNextPageError}
        hasNextPage={feedback.hasNextPage}
        isFetchingNextPage={feedback.isFetchingNextPage}
        onNext={() => void feedback.fetchNextPage()}
        onRetry={() => void feedback.fetchNextPage()}
      />
    </div>
  )
}

export function FeedbackQueueRow({
  item,
  search,
}: {
  item: AdminFeedbackItem
  search: FeedbackSearch
}) {
  const statusMeta = FEEDBACK_STATUS_META[item.feedback.status]
  return (
    <Link
      className="flex items-center gap-4 p-4 transition-colors hover:bg-surface-2/60"
      params={{ feedbackId: item.feedback.id }}
      search={withoutCursor(search)}
      to="/admin/feedback/$feedbackId"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
          <Badge variant="secondary">{FEEDBACK_TYPE_LABEL[item.feedback.type]}</Badge>
        </div>
        <p className="mt-1 truncate text-sm">{item.feedback.content}</p>
        <p className="mt-1 truncate text-ink-3 text-xs">
          提交人 {item.submitter.nickname} · {formatAdminDateTime(item.feedback.createdAt)}
        </p>
      </div>
      <span aria-hidden className="text-ink-3 text-sm">
        ›
      </span>
    </Link>
  )
}

/** validateSearch 共用实现（status 缺省 = PENDING；显式 `ALL` = 全状态视图）。 */
export function parseFeedbackSearch(search: Record<string, unknown>): FeedbackSearch {
  const status: FeedbackSearch['status'] =
    search.status === FEEDBACK_STATUS_ALL
      ? FEEDBACK_STATUS_ALL
      : (optionalSearch(FeedbackStatusSchema, search.status) ?? 'PENDING')
  const type = optionalSearch(FeedbackTypeSchema, search.type)
  const cursor = cursorSearch(search.cursor)
  return {
    status,
    ...(type !== undefined ? { type } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
