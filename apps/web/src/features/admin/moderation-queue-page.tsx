import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { formatDateTime } from './display'
import {
  useAdminModerationDetail,
  useAdminModerationQueue,
  useDecideAdminModeration,
} from './queries'

export function ModerationQueuePage() {
  const [page, setPage] = useState<{ cursor?: string; stack: (string | undefined)[] }>({
    stack: [],
  })
  const query = useAdminModerationQueue({ cursor: page.cursor, limit: 20 })
  if (query.isPending) return <LoadingState label="正在加载审核队列…" />
  if (query.isError)
    return <ErrorState message="审核队列加载失败" onRetry={() => void query.refetch()} />
  if (query.data.items.length === 0 && page.stack.length === 0) {
    return <EmptyState title="审核队列为空" description="当前没有等待人工复核的商品" emoji="✅" />
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-semibold text-lg">审核队列</h1>
        <p className="mt-1 text-sm text-ink-3">机器判定为 REVIEW 的商品，需要管理员人工决定。</p>
      </div>
      {query.data.items.length === 0 ? (
        <EmptyState description="这一页的记录已被其他管理员处理" emoji="✅" />
      ) : (
        <div className="space-y-3">
          {query.data.items.map((item) => (
            <Card className="p-4" key={item.record.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{item.listing.title}</h2>
                    <Badge shape="pill" variant="secondary">
                      待人工审核
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-ink-2">卖家：{item.seller.nickname}</p>
                  <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm text-ink-3">
                    {item.record.descriptionSnapshot}
                  </p>
                </div>
                <div className="shrink-0 text-right text-xs text-ink-3">
                  <p>规则版本 {item.record.ruleVersion}</p>
                  <p className="mt-1">{formatDateTime(item.record.createdAt)}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                <span>命中规则：{item.record.matchedRules.length || '无'}</span>
                {item.record.matchedRules.map((rule) => (
                  <Badge key={rule} shape="pill" variant="secondary">
                    {rule}
                  </Badge>
                ))}
              </div>
              <Link
                className="mt-3 inline-flex rounded-lg bg-brand px-3 py-1.5 text-sm text-white"
                params={{ recordId: item.record.id }}
                to="/admin/moderation/$recordId"
              >
                查看结果并处理
              </Link>
            </Card>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-3">
        <button
          className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={page.stack.length === 0 || query.isFetching}
          onClick={() =>
            setPage((current) => ({
              cursor: current.stack.at(-1),
              stack: current.stack.slice(0, -1),
            }))
          }
          type="button"
        >
          上一页
        </button>
        <button
          className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={!query.data.nextCursor || query.isFetching}
          onClick={() =>
            setPage((current) => ({
              cursor: query.data.nextCursor ?? undefined,
              stack: [...current.stack, current.cursor],
            }))
          }
          type="button"
        >
          下一页
        </button>
      </div>
    </div>
  )
}

export function ModerationDecisionForm({ recordId }: { recordId: string }) {
  const detail = useAdminModerationDetail(recordId)
  const decide = useDecideAdminModeration(recordId)
  const [reason, setReason] = useState('')
  const [selected, setSelected] = useState<'ALLOW' | 'BLOCK' | null>(null)
  const requestRef = useRef({ fingerprint: '', id: crypto.randomUUID() })

  if (detail.isPending) return <LoadingState label="正在加载审核详情…" />
  if (detail.isError)
    return <ErrorState message="审核详情加载失败" onRetry={() => void detail.refetch()} />
  const data = detail.data
  const submit = () => {
    if (!selected || !reason.trim() || decide.isPending) return
    if (!window.confirm(`确认将此商品判定为${selected === 'ALLOW' ? '通过' : '拦截'}吗？`)) return
    const fingerprint = `${selected}:${reason.trim()}`
    if (requestRef.current.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, id: crypto.randomUUID() }
    }
    decide.mutate({
      input: { decision: selected, reason: reason.trim() },
      requestId: requestRef.current.id,
    })
  }

  return (
    <div className="space-y-4">
      <Link className="text-sm text-ink-3 hover:text-ink" to="/admin/moderation">
        ← 返回审核队列
      </Link>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-semibold text-lg">{data.item.listing.title}</h1>
            <p className="mt-1 text-sm text-ink-3">卖家：{data.item.seller.nickname}</p>
          </div>
          <Badge
            shape="pill"
            variant={data.item.listing.moderationStatus === 'REVIEW' ? 'secondary' : 'default'}
          >
            {data.item.listing.moderationStatus === 'REVIEW'
              ? '待人工审核'
              : data.item.listing.moderationStatus}
          </Badge>
        </div>
        <p className="mt-4 whitespace-pre-wrap text-sm text-ink-2">
          {data.item.record.descriptionSnapshot}
        </p>
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">机器审核结果</h2>
        <p className="mt-2 text-sm">
          结论：{data.machineDecision ?? '未知'} · 规则版本：{data.item.record.ruleVersion}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {data.item.record.matchedTermsMasked.map((term) => (
            <Badge key={term} shape="pill" variant="secondary">
              {term}
            </Badge>
          ))}
        </div>
      </Card>
      {data.humanDecision ? (
        <Card className="p-4">
          <h2 className="font-semibold">人工最终决定</h2>
          <p className="mt-2 text-sm">
            {data.humanDecision.decision === 'ALLOW' ? '通过' : '拦截'}：{data.humanDecision.reason}
          </p>
        </Card>
      ) : (
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">人工决定</h2>
          <textarea
            className="min-h-24 w-full rounded-lg border border-line bg-surface p-2 text-sm outline-none focus:border-brand"
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="请填写决定原因（必填）"
            value={reason}
          />
          <div className="flex flex-wrap gap-2">
            <button
              className={`rounded-lg px-3 py-1.5 text-sm text-white ${selected === 'ALLOW' ? 'bg-green-700' : 'bg-green-600/80'}`}
              onClick={() => setSelected('ALLOW')}
              type="button"
            >
              通过
            </button>
            <button
              className={`rounded-lg px-3 py-1.5 text-sm text-white ${selected === 'BLOCK' ? 'bg-red-700' : 'bg-red-600/80'}`}
              onClick={() => setSelected('BLOCK')}
              type="button"
            >
              拦截
            </button>
            <button
              className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={!selected || !reason.trim() || decide.isPending}
              onClick={submit}
              type="button"
            >
              {decide.isPending ? '提交中…' : '确认提交'}
            </button>
          </div>
          {decide.isError ? (
            <p className="text-sm text-red-600">提交失败：{decide.error.message}</p>
          ) : null}
        </Card>
      )}
      <Card className="p-4">
        <h2 className="mb-2 font-semibold">审核时间线</h2>
        <ul className="divide-y divide-line text-sm">
          {data.history.map((record) => (
            <li className="py-2" key={record.id}>
              {record.action} · {record.decision} · {formatDateTime(record.createdAt)}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
