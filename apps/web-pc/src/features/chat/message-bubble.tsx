import type { MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@fish/ui/dialog'
import { UserAvatar } from '@fish/ui/user-avatar'
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { formatVoiceDuration } from './media'
import type { OutboxMediaMessage, OutboxTextMessage } from './outbox'
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

/**
 * IMAGE / VOICE 气泡（#67）。媒体消息是独立的 `MediaMessageDto`，没有 sender 摘要，
 * 因此不渲染头像与昵称；`src` 直接用服务端下发的鉴权代理路径（`/api/...`），
 * 绝不拼对象存储的公开地址——私有媒体只能经会话权限校验读取。
 */
export function MediaBubble({
  media,
  isMine,
  isRead,
}: {
  media: MediaMessageDto
  isMine: boolean
  isRead: boolean
}) {
  const [previewOpen, setPreviewOpen] = useState(false)
  return (
    <div className={`flex gap-2.5 ${isMine ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[70%] flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        {media.kind === 'IMAGE' ? (
          <>
            <button
              className="overflow-hidden rounded-2xl border border-line bg-surface transition-opacity hover:opacity-90"
              onClick={() => setPreviewOpen(true)}
              type="button"
            >
              <img
                alt="图片消息"
                className="max-h-[320px] w-auto max-w-full object-cover"
                loading="lazy"
                src={media.url}
              />
            </button>
            <Dialog onOpenChange={setPreviewOpen} open={previewOpen}>
              <DialogContent className="max-w-[92vw] p-4 sm:max-w-3xl">
                <DialogHeader>
                  <DialogTitle>图片预览</DialogTitle>
                </DialogHeader>
                <img
                  alt="图片消息预览"
                  className="mx-auto max-h-[80vh] w-auto max-w-full object-contain"
                  src={media.url}
                />
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <div className="flex flex-col gap-1 rounded-2xl border border-line bg-surface px-3 py-2">
            {/*
              biome-ignore lint/a11y/useMediaCaption: 语音是用户自己录的音频，客户端拿不到
              转写内容，无法生成有意义的字幕轨。
            */}
            <audio className="h-9 w-60" controls preload="metadata" src={media.url} />
            <span className="text-[11px] text-ink-3">
              语音 {formatVoiceDuration(media.durationMs)}
            </span>
          </div>
        )}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
          <time dateTime={media.createdAt}>{formatMessageTime(media.createdAt)}</time>
          {isMine && isRead ? <span>已读</span> : null}
        </div>
      </div>
    </div>
  )
}

/** 发送中 / 失败态共用的尾部：状态文案、重试、仅移除本地记录。 */
function PendingFooter({
  failed,
  error,
  errorCode,
  onRetry,
  onDismiss,
}: {
  failed: boolean
  error: string | null
  errorCode: string | null
  onRetry: () => void
  onDismiss: () => void
}) {
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px]">
      {failed ? null : <span className="text-ink-3">发送中…</span>}
      {failed ? (
        <>
          <span className="inline-flex items-center gap-1 text-danger">
            <AlertCircle className="size-3" />
            {error}
          </span>
          {errorCode === 'IDEMPOTENCY_KEY_REUSED' ? null : (
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
  )
}

export function PendingMessageBubble({
  item,
  onRetry,
  onDismiss,
}: {
  item: OutboxTextMessage
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
        <PendingFooter
          error={item.error}
          errorCode={item.errorCode}
          failed={failed}
          onDismiss={onDismiss}
          onRetry={onRetry}
        />
      </div>
    </div>
  )
}

export function PendingMediaBubble({
  item,
  onRetry,
  onDismiss,
}: {
  item: OutboxMediaMessage
  onRetry: () => void
  onDismiss: () => void
}) {
  const failed = item.status === 'failed'
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[70%] flex-col items-end">
        <div className={`overflow-hidden rounded-2xl ${failed ? 'opacity-60' : ''}`}>
          {item.draft.kind === 'IMAGE' ? (
            <img
              alt="待发送图片"
              className="max-h-[320px] w-auto max-w-full object-cover"
              src={item.previewUrl}
            />
          ) : (
            <div className="flex flex-col gap-1 rounded-2xl border border-line bg-surface px-3 py-2">
              {/*
                biome-ignore lint/a11y/useMediaCaption: 语音是用户自己录的音频，客户端拿不到
                转写内容，无法生成有意义的字幕轨。
              */}
              <audio className="h-9 w-60" controls preload="metadata" src={item.previewUrl} />
              <span className="text-[11px] text-ink-3">
                语音 {formatVoiceDuration(item.draft.durationMs)}
              </span>
            </div>
          )}
        </div>
        <PendingFooter
          error={item.error}
          errorCode={item.errorCode}
          failed={failed}
          onDismiss={onDismiss}
          onRetry={onRetry}
        />
      </div>
    </div>
  )
}
