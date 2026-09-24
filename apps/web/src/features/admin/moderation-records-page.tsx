import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@fish/ui/select'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useId, useState } from 'react'
import {
  formatDateTime,
  LISTING_STATUS_LABEL,
  MODERATION_DECISION_LABEL,
  MODERATION_DECISION_VARIANT,
  shortId,
  statusLabel,
} from './display'
import { useAdminModerationRecords } from './queries'

/**
 * 审核记录检索（#73 治理半场 PR4）。
 *
 * 与审核队列的分工：队列是「待我处理」的工作清单（服务端写死只列 REVIEW 商品、
 * 每条 listing 只留最新记录）；本页查**已经离开队列的历史**——被人工决定过的、
 * 机器直接放行的、以及仍在 REVIEW 的，都能在这里按判定 / 商品 / 关键词 / 时间段捞出来。
 *
 * 筛选写入 URL（刷新 / 复制可复现），值域白名单在路由层校验；筛选一变就重置游标，
 * 否则会带着上一组条件的 cursor 查新条件，第二页直接空。
 *
 * 日期在 URL 里存 `YYYY-MM-DD`（人类可读、可直接改），发给 API 前转成 ISO：
 * `createdFrom` 取当天 00:00，`createdTo` 取**次日** 00:00——服务端是左闭右开
 * （`>= from` 且 `< to`），用当天 23:59:59.999 会漏掉最后一毫秒内的记录。
 */
export type AdminModerationRecordsSearch = {
  decision?: string
  listingId?: string
  q?: string
  createdFrom?: string
  createdTo?: string
}

type PageState = { cursor: string | null; stack: (string | null)[] }

const DECISIONS = ['REVIEW', 'ALLOW', 'BLOCK'] as const
/** 本地时区当天 00:00 的 ISO；非法日期返回 null。 */
function startOfDayIso(date: string): string | null {
  const parsed = new Date(`${date}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** 次日本地时区 00:00 的 ISO（左闭右开的右端）。 */
function nextDayIso(date: string): string | null {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setDate(parsed.getDate() + 1)
  return parsed.toISOString()
}

export function ModerationRecordsPage({ search }: { search: AdminModerationRecordsSearch }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(search.q ?? '')
  const [page, setPage] = useState<PageState>({ cursor: null, stack: [] })
  const createdFromId = useId()
  const createdToId = useId()

  const query = useAdminModerationRecords({
    decision: search.decision,
    listingId: search.listingId,
    q: search.q,
    createdFrom: search.createdFrom ? (startOfDayIso(search.createdFrom) ?? undefined) : undefined,
    createdTo: search.createdTo ? (nextDayIso(search.createdTo) ?? undefined) : undefined,
    cursor: page.cursor ?? undefined,
    limit: 20,
  })

  const applySearch = (patch: Partial<AdminModerationRecordsSearch>) => {
    setPage({ cursor: null, stack: [] })
    void navigate({
      to: '/admin/moderation/records',
      search: {
        decision: search.decision,
        listingId: search.listingId,
        q: search.q,
        createdFrom: search.createdFrom,
        createdTo: search.createdTo,
        ...patch,
      },
    })
  }

  const nextPage = () => {
    if (!query.data?.nextCursor) return
    setPage((prev) => ({
      cursor: query.data?.nextCursor ?? null,
      stack: [...prev.stack, prev.cursor],
    }))
  }
  const prevPage = () => {
    setPage((prev) => {
      const stack = [...prev.stack]
      const previous = stack.pop() ?? null
      return { cursor: previous, stack }
    })
  }

  if (query.isPending) return <LoadingState label="正在加载审核记录…" />
  if (query.isError)
    return <ErrorState message="审核记录加载失败" onRetry={() => void query.refetch()} />

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-semibold text-lg">审核记录</h1>
        <p className="mt-1 text-sm text-ink-3">
          已离开审核队列的历史记录，可按判定、商品、关键词与时间段检索。
        </p>
      </div>

      <Card className="flex flex-wrap items-center gap-3 p-3">
        <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5">
          <Search className="size-4 text-ink-3" />
          <Input
            className="h-auto w-44 border-0 bg-transparent p-0 text-sm shadow-none"
            maxLength={50}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applySearch({ q: draft.trim() || undefined })
            }}
            placeholder="商品标题子串"
            value={draft}
          />
        </div>
        <Select
          onValueChange={(value) => applySearch({ decision: value === 'all' ? undefined : value })}
          value={search.decision ?? 'all'}
        >
          <SelectTrigger className="h-9 w-32 text-sm">
            {search.decision
              ? (MODERATION_DECISION_LABEL[search.decision] ?? search.decision)
              : '全部判定'}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部判定</SelectItem>
            {DECISIONS.map((decision) => (
              <SelectItem key={decision} value={decision}>
                {MODERATION_DECISION_LABEL[decision]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-ink-2" htmlFor={createdFromId}>
          起始
          <Input
            className="h-9 w-40 text-sm"
            id={createdFromId}
            onChange={(event) => applySearch({ createdFrom: event.target.value || undefined })}
            type="date"
            value={search.createdFrom ?? ''}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2" htmlFor={createdToId}>
          截止
          <Input
            className="h-9 w-40 text-sm"
            id={createdToId}
            onChange={(event) => applySearch({ createdTo: event.target.value || undefined })}
            type="date"
            value={search.createdTo ?? ''}
          />
        </label>
        {search.listingId ? (
          <span className="flex items-center gap-2 text-sm text-ink-2">
            仅看商品 {shortId(search.listingId)}
            <button
              className="rounded-lg border border-line px-2 py-1 text-xs"
              onClick={() => applySearch({ listingId: undefined })}
              type="button"
            >
              清除
            </button>
          </span>
        ) : null}
      </Card>

      {query.data.items.length === 0 ? (
        <EmptyState description="没有符合条件的审核记录" emoji="🗂️" />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th className="px-3 py-2">商品</th>
                <th className="px-3 py-2">卖家</th>
                <th className="px-3 py-2">判定</th>
                <th className="px-3 py-2">命中规则</th>
                <th className="px-3 py-2">记录时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {query.data.items.map((item) => (
                <tr key={item.record.id}>
                  <td className="px-3 py-2.5">
                    <p className="font-medium">{item.listing.title}</p>
                    <p className="text-xs text-ink-3">
                      {statusLabel(LISTING_STATUS_LABEL, item.listing.status)} ·{' '}
                      {shortId(item.listing.id)}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{item.seller.nickname}</td>
                  <td className="px-3 py-2.5">
                    <Badge
                      shape="pill"
                      variant={MODERATION_DECISION_VARIANT[item.record.decision] ?? 'default'}
                    >
                      {statusLabel(MODERATION_DECISION_LABEL, item.record.decision)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">
                    {item.record.matchedRules.length === 0
                      ? '—'
                      : item.record.matchedRules.join('、')}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-3">
                    <Link
                      className="hover:text-ink"
                      params={{ recordId: item.record.id }}
                      to="/admin/moderation/$recordId"
                    >
                      {formatDateTime(item.record.createdAt)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="flex justify-end gap-3">
        <button
          className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={page.stack.length === 0 || query.isFetching}
          onClick={prevPage}
          type="button"
        >
          上一页
        </button>
        <button
          className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={!query.data.nextCursor || query.isFetching}
          onClick={nextPage}
          type="button"
        >
          下一页
        </button>
      </div>
    </div>
  )
}
