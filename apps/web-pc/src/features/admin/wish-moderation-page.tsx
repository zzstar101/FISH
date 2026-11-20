import type { WishModerationQueueItem } from '@fish/contracts/wishes/moderation'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { adminLoadOutcome } from './admin-messages'
import { useWishModerationDecision, useWishModerationQueue } from './admin-queries'
import { formatAdminDateTime } from './admin-view'

/**
 * 许愿待审（#694 M5）。最小上下文：本次提交的 keyword/description（新建时就是公开内容，
 * 编辑时 current* 是线上仍可见的旧值），机器判定与命中词；管理员只做放行/拒绝，必须填原因。
 */
export function WishModerationItemCard({
  item,
  onSelect,
}: {
  item: WishModerationQueueItem
  onSelect: (item: WishModerationQueueItem) => void
}) {
  return (
    <Card key={item.id} className="gap-3 border border-line p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warn">愿望</Badge>
        <span className="font-medium text-sm">{item.author.nickname}</span>
        <span className="text-ink-3 text-xs">
          版本 {item.contentVersion} · {item.provider} · 机器判定 {item.suggestion ?? '未知'}
          {item.score !== null ? ` · ${item.score} 分` : ''} · {formatAdminDateTime(item.createdAt)}
        </span>
        {item.matchedTermsMasked.length > 0 ? (
          <span className="text-ink-3 text-xs">命中词：{item.matchedTermsMasked.join('、')}</span>
        ) : null}
      </div>

      <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
        <p className="whitespace-pre-wrap break-words">
          <span className="text-ink-3">关键词：</span>
          {item.keyword}
        </p>
        {item.description ? (
          <p className="whitespace-pre-wrap break-words">
            <span className="text-ink-3">描述：</span>
            {item.description}
          </p>
        ) : null}
        {item.contentVersion > 1 ? (
          <p className="whitespace-pre-wrap break-words text-ink-3 text-xs">
            线上仍为：{item.currentKeyword}
            {item.currentDescription ? ` / ${item.currentDescription}` : ''}
          </p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSelect(item)}>
          放行 / 拒绝
        </Button>
      </div>
    </Card>
  )
}

export function WishModerationPage() {
  const queue = useWishModerationQueue()
  const decision = useWishModerationDecision()
  const [selected, setSelected] = useState<WishModerationQueueItem | null>(null)
  const [reason, setReason] = useState('')
  const [conflict, setConflict] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  if (queue.isPending) return <LoadingState label="正在加载许愿待审…" />
  if (queue.isError) {
    const outcome = adminLoadOutcome(queue.error)
    if (outcome.kind === 'forbidden') {
      return <EmptyState title="无权访问" description="当前账号没有公开内容审核权限。" />
    }
    return <ErrorState message="许愿待审加载失败" onRetry={() => void queue.refetch()} />
  }

  const items = queue.data.pages.flatMap((page) => page.items)

  function close() {
    setSelected(null)
    setReason('')
  }

  async function submit(value: 'ALLOW' | 'BLOCK') {
    if (!selected) return
    setConflict(false)
    try {
      await decision.mutateAsync({
        recordId: selected.id,
        input: { decision: value, reason: reason.trim(), version: selected.version },
      })
      close()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WISH_MODERATION_CONFLICT') {
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
        <h1 className="font-semibold text-2xl">许愿待审</h1>
        <p className="mt-1 text-ink-3 text-sm">
          机器判定为 REVIEW 的许愿墙内容。放行后进入需求池并恢复匹配投递；拒绝后不公开，
          编辑被拒时线上保留原内容。
        </p>
      </div>

      {conflict ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          这条记录已被其他管理员处理或版本已过期，队列已刷新，请重新选择。
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          {actionError}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title="没有待审许愿" description="当前没有等待人工复核的公开内容。" />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <WishModerationItemCard
              key={item.id}
              item={item}
              onSelect={(next) => {
                setActionError(null)
                setConflict(false)
                setSelected(next)
              }}
            />
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
          <h2 className="font-semibold">处理愿望（版本 {selected.contentVersion}）</h2>
          <label className="text-sm" htmlFor="wish-moderation-reason">
            处理原因（必填，写入审计）
          </label>
          <textarea
            id="wish-moderation-reason"
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
              放行
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
