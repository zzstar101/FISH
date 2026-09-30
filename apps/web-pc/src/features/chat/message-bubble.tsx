import type { ConversationListing, MessageDto } from '@fish/contracts/chat/schema'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import type { OutboxMessage } from './outbox'
import { formatMessageTime, systemMessageText } from './view'

/** 与 `conversation-page.tsx` 同源的文案（那边是会话头商品卡用的同一套）。 */
const STATUS_LABEL: Record<ListingStatus, string> = {
  ACTIVE: '在售',
  RESERVED: '已预定',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

/**
 * 商品卡气泡（#359）：`content` 里存的是商品**公开 id**，可渲染的卡片数据由服务端的
 * `listing` 投射携带（`MessageDto.listing`，历史与 `message.new` 同源）。
 *
 * 两个必须处理的边界：
 * - 投射缺失（商品被物理删除）→ 退化成不可点的 `[商品]` 占位，**绝不能把 `lst_…`
 *   当正文画出来**（那正是这条气泡在本分支修掉的问题）；
 * - 详情对「非卖家的 OFFLINE / 未过审」一律 404（`listings/service.ts` 的 `loadDetail`）
 *   → 已下架且不是自己发的卡不给可点入口，自己发的仍然可看。
 */
function ListingBubble({
  listing,
  isMine,
}: {
  listing: ConversationListing | null | undefined
  isMine: boolean
}) {
  if (!listing) {
    return (
      <div className="rounded-2xl border border-line bg-surface-2 px-3.5 py-2.5 text-ink-3 text-sm leading-6">
        [商品]
      </div>
    )
  }

  const card = (
    <>
      <ListingThumb
        alt={listing.title}
        className="size-11 shrink-0 rounded-lg"
        coverUrl={listing.coverUrl}
        listingId={listing.id}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink text-sm">{listing.title}</p>
        <p className="mt-0.5 text-ink-3 text-xs">
          {`${STATUS_LABEL[listing.status] ?? listing.status} · 点击查看商品`}
        </p>
      </div>
      <PriceText cents={listing.priceCents} className="shrink-0 font-bold text-sm" />
    </>
  )
  const cardClass =
    'flex w-60 max-w-full items-center gap-2.5 rounded-xl border border-line bg-surface p-2'

  if (isMine || listing.status !== 'OFFLINE') {
    return (
      <Link
        className={`${cardClass} transition-colors hover:bg-surface-2`}
        params={{ listingId: listing.id }}
        to="/listing/$listingId"
      >
        {card}
      </Link>
    )
  }
  return <div className={cardClass}>{card}</div>
}

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
        {message.type === 'LISTING' ? (
          <ListingBubble isMine={isMine} listing={message.listing} />
        ) : (
          <div
            className={`rounded-2xl px-3.5 py-2.5 text-sm leading-6 ${
              isMine
                ? 'rounded-br-md bg-brand text-white'
                : 'rounded-bl-md border border-line bg-surface text-ink'
            }`}
          >
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        )}
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
