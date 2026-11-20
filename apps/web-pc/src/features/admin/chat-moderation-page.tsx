import type { ChatModerationQueueItem } from '@fish/contracts/moderation/chat-schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useState } from 'react'
import { adminChatModerationMediaPath } from './admin-api'
import { adminLoadOutcome } from './admin-messages'
import { useChatModerationDecision, useChatModerationQueue } from './admin-queries'
import { formatAdminDateTime } from './admin-view'

const KIND_LABEL: Record<ChatModerationQueueItem['kind'], string> = {
  TEXT: '文字',
  IMAGE: '图片',
  VOICE: '语音',
}

/**
 * 聊天待审（#694 M2）。最小上下文：单条文字正文，或图片快照（管理员会话下直取）；
 * 处理必须填写原因，决策带乐观版本，冲突时提示刷新而不是覆盖别人的结论。
 */
export function ChatModerationItemCard({
  item,
  onSelect,
}: {
  item: ChatModerationQueueItem
  onSelect: (item: ChatModerationQueueItem) => void
}) {
  return (
    <Card key={item.id} className="gap-3 border border-line p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warn">{KIND_LABEL[item.kind]}</Badge>
        <span className="font-medium text-sm">{item.sender.nickname}</span>
        <span className="text-ink-3 text-xs">
          {item.provider} · v{item.version} · {formatAdminDateTime(item.createdAt)}
        </span>
        {item.matchedTermsMasked.length > 0 ? (
          <span className="text-ink-3 text-xs">命中词：{item.matchedTermsMasked.join('、')}</span>
        ) : null}
      </div>

      {item.kind === 'IMAGE' && item.hasMedia ? (
        <img
          src={adminChatModerationMediaPath(item.id)}
          alt="待审图片快照"
          className="max-h-72 rounded-xl border border-line object-contain"
        />
      ) : (
        <p className="whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-3 text-sm">
          {item.content ?? '（无正文）'}
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSelect(item)}>
          放行 / 拒绝
        </Button>
      </div>
    </Card>
  )
}

export function ChatModerationPage() {
  const queue = useChatModerationQueue()
  const decision = useChatModerationDecision()
  const [selected, setSelected] = useState<ChatModerationQueueItem | null>(null)
  const [reason, setReason] = useState('')
  const [conflict, setConflict] = useState(false)

  if (queue.isPending) return <LoadingState label="正在加载聊天待审…" />
  if (queue.isError) {
    const outcome = adminLoadOutcome(queue.error)
    if (outcome.kind === 'forbidden') {
      return <EmptyState title="无权访问" description="当前账号没有聊天审核权限。" />
    }
    return <ErrorState message="聊天待审加载失败" onRetry={() => void queue.refetch()} />
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
    } catch {
      setConflict(true)
      void queue.refetch()
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-semibold text-2xl">聊天待审</h1>
        <p className="mt-1 text-ink-3 text-sm">
          机器判定为 REVIEW
          的私聊消息。放行后只投递一次、只产生一次未读；拒绝后发送者仍能看到稳定状态。
        </p>
      </div>

      {conflict ? (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
          这条记录已被其他管理员处理或版本已过期，队列已刷新，请重新选择。
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title="没有待审消息" description="当前没有等待人工复核的私聊内容。" />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ChatModerationItemCard key={item.id} item={item} onSelect={setSelected} />
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
          <h2 className="font-semibold">处理 {KIND_LABEL[selected.kind]}消息</h2>
          <label className="text-sm" htmlFor="chat-moderation-reason">
            处理原因（必填，写入审计）
          </label>
          <textarea
            id="chat-moderation-reason"
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
              放行并投递
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
