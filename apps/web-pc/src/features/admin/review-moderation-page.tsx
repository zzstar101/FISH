import type { ReviewModerationQueueItem } from '@fish/contracts/transaction-reviews/moderation'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { adminReviewModerationMediaPath } from './admin-api'
import { adminLoadOutcome } from './admin-messages'
import { useReviewModerationDecision, useReviewModerationQueue } from './admin-queries'
import { formatAdminDateTime } from './admin-view'

const RATING_LABEL: Record<'POSITIVE' | 'NEUTRAL' | 'NEGATIVE', string> = {
  POSITIVE: '好评',
  NEUTRAL: '中评',
  NEGATIVE: '差评',
}

/**
 * 交易评价图片待审（#694 M5c）。队列里是机器判定 REVIEW、已挂到评价上的配图；
 * 放行会在服务端把私有字节搬到公开键并改写评价引用，拒绝只结算、不产生公开对象。
 */
export function ReviewModerationPage() {
  const queue = useReviewModerationQueue()
  const decision = useReviewModerationDecision()
  const [selected, setSelected] = useState<ReviewModerationQueueItem | null>(null)
  const [reason, setReason] = useState('')
  const [conflict, setConflict] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  if (queue.isPending) return <LoadingState label="正在加载评价图片待审…" />
  if (queue.isError) {
    const outcome = adminLoadOutcome(queue.error)
    if (outcome.kind === 'forbidden') {
      return <EmptyState title="无权访问" description="当前账号没有交易评价审核权限。" />
    }
    return <ErrorState message="评价图片待审加载失败" onRetry={() => void queue.refetch()} />
  }

  const items = queue.data.pages.flatMap((page) => page.items)

  function close() {
    setSelected(null)
    setReason('')
  }

  async function submit(value: 'ALLOW' | 'BLOCK') {
    if (!selected) return
    setConflict(false)
    setActionError(null)
    try {
      await decision.mutateAsync({
        recordId: selected.id,
        input: { decision: value, reason: reason.trim(), version: selected.version },
      })
      close()
    } catch (error) {
      // 只有版本/字节冲突才提示「被别人处理/对象已变化」；403、网络错误按普通失败展示。
      if (error instanceof ApiError && error.code === 'REVIEW_MODERATION_CONFLICT') {
        setConflict(true)
        void queue.refetch()
        return
      }
      setActionError(error instanceof Error ? error.message : '处理失败，请重试')
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-2xl">评价图片待审</h1>
        <p className="mt-1 text-ink-3 text-sm">
          机器判定为 REVIEW
          的交易评价配图。放行后图片才会公开、评价才会对交易对方可见；拒绝后作者需要更换图片。
        </p>
      </div>

      {conflict ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          这条记录已被其他管理员处理，或图片字节已变化，队列已刷新，请重新选择。
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          {actionError}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title="没有待审图片" description="当前没有等待人工复核的交易评价配图。" />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id} className="gap-3 border border-line p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warn">评价图片</Badge>
                <span className="font-medium text-sm">{item.author.nickname}</span>
                <span className="text-ink-3 text-xs">
                  {item.provider} · 机器判定 {item.suggestion ?? '未知'}
                  {item.score !== null ? ` · ${item.score} 分` : ''} ·{' '}
                  {formatAdminDateTime(item.createdAt)}
                </span>
                {item.matchedTermsMasked.length > 0 ? (
                  <span className="text-ink-3 text-xs">
                    命中词：{item.matchedTermsMasked.join('、')}
                  </span>
                ) : null}
              </div>

              <div className="text-sm">
                <span className="text-ink-3">商品：</span>
                {item.transaction.listing.title}
                {item.review ? (
                  <>
                    <span className="text-ink-3"> · 评分：</span>
                    {RATING_LABEL[item.review.rating]}
                  </>
                ) : null}
              </div>

              {item.review?.body ? (
                <p className="whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-3 text-sm">
                  {item.review.body}
                </p>
              ) : (
                <p className="text-ink-3 text-sm">（无正文）</p>
              )}

              <img
                src={adminReviewModerationMediaPath(item.id)}
                alt="待审评价图片"
                className="max-h-72 rounded-xl border border-line object-contain"
              />

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setActionError(null)
                    setConflict(false)
                    setSelected(item)
                  }}
                >
                  放行 / 拒绝
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {queue.hasNextPage ? (
        <Button variant="outline" onClick={() => void queue.fetchNextPage()}>
          加载更多
        </Button>
      ) : null}

      {selected ? (
        <Card className="gap-3 border border-brand/40 p-5">
          <h2 className="font-semibold">处理评价图片</h2>
          <label className="text-sm" htmlFor="review-moderation-reason">
            处理原因（必填，写入审计）
          </label>
          <textarea
            id="review-moderation-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-24 rounded-xl border border-line bg-surface p-3 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={reason.trim().length === 0 || decision.isPending}
              onClick={() => void submit('ALLOW')}
            >
              放行并公开
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={reason.trim().length === 0 || decision.isPending}
              onClick={() => void submit('BLOCK')}
            >
              拒绝
            </Button>
            <Button size="sm" variant="ghost" onClick={close}>
              取消
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
