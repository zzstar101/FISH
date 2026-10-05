import type { AdminModerationRecords } from '@fish/contracts/admin/schema'
import { ModerationDecisionSchema } from '@fish/contracts/moderation/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  DateRangeFilter,
  FilterChips,
  ForbiddenInline,
  KeywordFilter,
  LoadMore,
} from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminModerationQueue, useAdminModerationRecords } from './admin-queries'
import {
  cursorSearch,
  dayRangeSearch,
  optionalSearch,
  trimmedSearch,
  withoutCursor,
} from './admin-search'
import { formatAdminDateTime, moderationDecisionMeta } from './admin-view'

export type ModerationSearch = {
  tab: 'queue' | 'records'
  decision?: 'ALLOW' | 'BLOCK' | 'REVIEW'
  listingId?: string
  q?: string
  from?: string
  to?: string
  cursor?: string
}

/**
 * 审核页（#467 验收「待审队列、历史检索」）：队列 = 每 listing 最新 REVIEW（工作清单），
 * 历史 = 已离开队列的全部记录（含 ALLOW/BLOCK/仍 REVIEW）。tab 与筛选全在 URL。
 */
export function ModerationPage({ search }: { search: ModerationSearch }) {
  return search.tab === 'records' ? (
    <ModerationRecordsSection search={search} />
  ) : (
    <ModerationQueueSection search={search} />
  )
}

function ModerationQueueSection({ search }: { search: ModerationSearch }) {
  const navigate = useNavigate()
  const queue = useAdminModerationQueue()

  if (queue.isError) {
    const outcome = adminLoadOutcome(queue.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="审核队列加载失败" onRetry={() => void queue.refetch()} />
  }

  const items = queue.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">人工审核</h1>
        <p className="mt-1.5 text-ink-3 text-sm">机器判 REVIEW 的商品，每个商品只保留最新一条。</p>
      </div>

      <TabSwitch navigate={navigate} search={search} />

      {queue.isPending ? <LoadingState label="正在加载审核队列…" /> : null}
      {queue.isSuccess && items.length === 0 ? (
        <EmptyState description="没有待人工审核的商品。" emoji="✅" title="队列为空" />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <ModerationRow highlight="REVIEW" item={item} key={item.record.id} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={queue.isFetchNextPageError}
        hasNextPage={queue.hasNextPage}
        isFetchingNextPage={queue.isFetchingNextPage}
        onNext={() => void queue.fetchNextPage()}
        onRetry={() => void queue.fetchNextPage()}
      />
    </div>
  )
}

function ModerationRecordsSection({ search }: { search: ModerationSearch }) {
  const navigate = useNavigate()
  const range = dayRangeSearch(search.from, search.to)
  const filters = {
    decision: search.decision,
    listingId: search.listingId,
    q: search.q,
    createdFrom: range.createdFrom,
    createdTo: range.createdTo,
  }
  const records = useAdminModerationRecords(filters)

  function update(next: Partial<ModerationSearch>) {
    void navigate({ to: '/admin/moderation', search: { ...withoutCursor(search), ...next } })
  }

  if (records.isError) {
    const outcome = adminLoadOutcome(records.error)
    if (outcome.kind === 'forbidden') return <ForbiddenInline />
    return <ErrorState message="审核记录加载失败" onRetry={() => void records.refetch()} />
  }

  const items = records.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">审核记录</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          历史记录检索：按判定 / 商品 / 关键词（当前标题与描述）/ 时间段。
        </p>
      </div>

      <TabSwitch navigate={navigate} search={search} />

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="判定筛选"
          onChange={(decision) => update({ decision: decision as ModerationSearch['decision'] })}
          options={[
            { value: 'ALLOW', label: '已放行' },
            { value: 'BLOCK', label: '已拦截' },
            { value: 'REVIEW', label: '待人工' },
          ]}
          value={search.decision}
        />
        <KeywordFilter
          onCommit={(q) => update({ q })}
          placeholder="商品标题或描述"
          value={search.q}
        />
        <DateRangeFilter
          fromValue={search.from}
          onCommit={({ from, to }) => update({ from, to })}
          toValue={search.to}
        />
      </div>

      {search.listingId !== undefined ? (
        <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-brand text-sm" role="status">
          正在按商品过滤（{search.listingId}），
          <button
            className="font-semibold underline"
            onClick={() => update({ listingId: undefined })}
            type="button"
          >
            清除
          </button>
        </p>
      ) : null}

      {records.isPending ? <LoadingState label="正在加载审核记录…" /> : null}
      {records.isSuccess && items.length === 0 ? (
        <EmptyState description="换个筛选条件试试" emoji="🗂️" title="没有匹配的审核记录" />
      ) : null}

      {items.length > 0 ? (
        <Card className="gap-0 divide-y divide-line border border-line p-0">
          {items.map((item) => (
            <ModerationRow highlight={item.record.decision} item={item} key={item.record.id} />
          ))}
        </Card>
      ) : null}

      <LoadMore
        error={records.isFetchNextPageError}
        hasNextPage={records.hasNextPage}
        isFetchingNextPage={records.isFetchingNextPage}
        onNext={() => void records.fetchNextPage()}
        onRetry={() => void records.fetchNextPage()}
      />
    </div>
  )
}

function TabSwitch({
  navigate,
  search,
}: {
  navigate: ReturnType<typeof useNavigate>
  search: ModerationSearch
}) {
  const tabs = [
    { value: 'queue' as const, label: '待审队列' },
    { value: 'records' as const, label: '历史记录' },
  ]
  return (
    <div className="flex gap-2">
      {tabs.map((tab) => {
        const active = tab.value === search.tab
        return (
          <button
            aria-pressed={active}
            className={`h-9 rounded-full px-4 text-sm transition-colors ${
              active
                ? 'bg-brand font-semibold text-white'
                : 'bg-surface text-ink-2 hover:bg-brand-soft hover:text-brand'
            }`}
            key={tab.value}
            onClick={() =>
              void navigate({
                to: '/admin/moderation',
                search: { ...withoutCursor(search), tab: tab.value },
              })
            }
            type="button"
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

/** 历史记录的商品可为 null（物理删除后仍展示快照）；队列条目（非空）是它的子集。 */
type ModerationRowItem = AdminModerationRecords['items'][number]

export function ModerationRow({
  highlight,
  item,
}: {
  highlight: 'ALLOW' | 'BLOCK' | 'REVIEW'
  item: ModerationRowItem
}) {
  const decisionMeta = moderationDecisionMeta(highlight)
  return (
    <Link
      className="block p-4 transition-colors hover:bg-surface-2/60"
      params={{ recordId: item.record.id }}
      search={{ tab: 'queue' }}
      to="/admin/moderation/$recordId"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-sm">
              {item.listing === null
                ? `（商品已删除）${item.record.titleSnapshot}`
                : item.listing.title}
            </span>
            <Badge variant={decisionMeta.variant}>{decisionMeta.label}</Badge>
            {item.record.provider !== null ? (
              <Badge variant="secondary">
                {item.record.provider === 'LOCAL'
                  ? '本地词表'
                  : item.record.provider === 'MANUAL'
                    ? '人工'
                    : '腾讯云'}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-1 text-ink-3 text-xs">{item.record.descriptionSnapshot}</p>
          <p className="mt-1 text-ink-3 text-xs">
            卖家 {item.seller.nickname} · {formatAdminDateTime(item.record.createdAt)} · 规则{' '}
            {item.record.ruleVersion}
          </p>
        </div>
        <span aria-hidden className="shrink-0 text-ink-3 text-sm">
          ›
        </span>
      </div>
    </Link>
  )
}

/** validateSearch 共用实现（tab 缺省 = queue）。 */
export function parseModerationSearch(search: Record<string, unknown>): ModerationSearch {
  const decision = optionalSearch(ModerationDecisionSchema, search.decision)
  const q = trimmedSearch(search.q)
  const listingId =
    typeof search.listingId === 'string' && search.listingId.length > 0
      ? search.listingId
      : undefined
  const from =
    typeof search.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.from)
      ? search.from
      : undefined
  const to =
    typeof search.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.to) ? search.to : undefined
  const cursor = cursorSearch(search.cursor)
  const tab = search.tab === 'records' ? 'records' : 'queue'
  return {
    tab,
    ...(decision !== undefined ? { decision } : {}),
    ...(listingId !== undefined ? { listingId } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
