import type { MessageDto } from '@fish/contracts/chat/schema'
import { UserAvatar } from '@fish/ui/user-avatar'
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react'
import type { OutboxMessage } from './outbox'
import { formatMessageTime, systemMessageText } from './view'

export function MessageBubble({
  message,
  isMine,
  isRead,
}: {
  message: MessageDto
  isMine: boolean
  isRead: boolean
}) {
  if (message.type === 'SYSTEM') {
    return (
      <div className="my-3 flex justify-center">
        <span className="max-w-[80%] rounded-full bg-surface-2 px-3.5 py-1.5 text-center text-ink-3 text-xs leading-5">
          {systemMessageText(message.content)}
        </span>
      </div>
    )
  }

  /**
   * 撤回碑（#359 3c）：服务端撤回后不下发正文，照常渲染气泡会是一个空气泡。
   * 文案与小程序端一致；会话页的撤回入口本身不在本 Issue 范围（PC 只负责不再画空泡）。
   */
  if (message.recalledAt !== null) {
    return (
      <div className="my-3 flex justify-center">
        <span className="rounded-full bg-surface-2 px-3.5 py-1.5 text-center text-ink-3 text-xs leading-5">
          {isMine ? '你撤回了一条消息' : '对方撤回了一条消息'}
        </span>
      </div>
    )
  }

  const senderName = message.sender?.nickname ?? '用户'
  return (
    <div className={`flex gap-2.5 ${isMine ? 'justify-end' : 'justify-start'}`}>
      {isMine ? null : (
        <UserAvatar
          avatarUrl={message.sender?.avatarUrl ?? null}
          emoji={senderName.slice(0, 1)}
          size="sm"
        />
      )}
      <div className={`flex max-w-[70%] flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        {isMine ? null : <p className="mb-1 text-ink-3 text-xs">{senderName}</p>}
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-6 ${
            isMine
              ? 'rounded-br-md bg-brand text-white'
              : 'rounded-bl-md border border-line bg-surface text-ink'
          }`}
        >
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
          <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
          {isMine && isRead ? <span>已读</span> : null}
        </div>
      </div>
    </div>
  )
}

export function PendingMessageBubble({
  item,
  onRetry,
  onDismiss,
}: {
  item: OutboxMessage
  onRetry: () => void
  onDismiss: () => void
}) {
  const failed = item.status === 'failed'
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[70%] flex-col items-end">
        <div
          className={`rounded-2xl rounded-br-md px-3.5 py-2.5 text-sm leading-6 ${
            failed ? 'bg-danger-soft text-danger' : 'bg-brand/60 text-white'
          }`}
        >
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px]">
          {item.status === 'sending' ? <span className="text-ink-3">发送中…</span> : null}
          {failed ? (
            <>
              <span className="inline-flex items-center gap-1 text-danger">
                <AlertCircle className="size-3" />
                {item.error}
              </span>
              {item.errorCode === 'IDEMPOTENCY_KEY_REUSED' ? null : (
                <button
                  className="inline-flex items-center gap-0.5 text-brand hover:underline"
                  onClick={onRetry}
                  type="button"
                >
                  <RotateCcw className="size-3" />
                  重试
                </button>
              )}
              <button
                className="inline-flex items-center gap-0.5 text-ink-3 hover:text-danger"
                onClick={onDismiss}
                title="仅移除本地失败记录，不删除服务端消息"
                type="button"
              >
                <Trash2 className="size-3" />
                移除
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
