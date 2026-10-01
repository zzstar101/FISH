import type { ConversationListing, MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@fish/ui/dialog'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { formatVoiceDuration } from './media'
import type { OutboxMediaMessage, OutboxTextMessage } from './outbox'
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
 * - 已下架的卡不给可点入口：详情对「非商品卖家的 OFFLINE / 未过审」一律 404
 *   （`listings/service.ts` 的 `loadDetail` 判的是 `sellerId !== viewerId`）。判据**不能**
 *   用「这条卡是不是我发的」—— 分享页两侧都能选，买家也会发一张**别人的**卡，商品下架后
 *   它仍是「我发的」但点进去必然 404；而投射里没有 `sellerId`，判不出我是不是卖家，
 *   所以取保守口径：已下架一律不可点。
 */
function ListingBubble({ listing }: { listing: ConversationListing | null | undefined }) {
  if (!listing) {
    return (
      <div className="rounded-2xl border border-line bg-surface-2 px-3.5 py-2.5 text-ink-3 text-sm leading-6">
        [商品]
      </div>
    )
  }

  const openable = listing.status !== 'OFFLINE'
  const statusText = STATUS_LABEL[listing.status] ?? listing.status
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
        {/* 不可点时不留「点击查看商品」——不能给一个必败入口的暗示 */}
        <p className="mt-0.5 text-ink-3 text-xs">
          {openable ? `${statusText} · 点击查看商品` : statusText}
        </p>
      </div>
      <PriceText cents={listing.priceCents} className="shrink-0 font-bold text-sm" />
    </>
  )
  const cardClass =
    'flex w-60 max-w-full items-center gap-2.5 rounded-xl border border-line bg-surface p-2'

  if (openable) {
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
        {message.type === 'LISTING' ? (
          <ListingBubble listing={message.listing} />
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
  return (
    <div className={`flex gap-2.5 ${isMine ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[70%] flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        {media.kind === 'IMAGE' ? <ImageBubble media={media} /> : <VoiceBubble media={media} />}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
          <time dateTime={media.createdAt}>{formatMessageTime(media.createdAt)}</time>
          {isMine && isRead ? <span>已读</span> : null}
        </div>
      </div>
    </div>
  )
}

/** 鉴权读取失败（401/404/对象缺失）时的可见反馈，避免只剩一个破图或空播放器。 */
function MediaLoadFailed({ label }: { label: string }) {
  return (
    <p className="rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-ink-3 text-sm">
      {label}
    </p>
  )
}

function ImageBubble({ media }: { media: MediaMessageDto }) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  if (loadFailed) return <MediaLoadFailed label="图片加载失败，请刷新重试" />
  return (
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
          onError={() => setLoadFailed(true)}
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
            onError={() => setLoadFailed(true)}
            src={media.url}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

function VoiceBubble({ media }: { media: MediaMessageDto }) {
  const [loadFailed, setLoadFailed] = useState(false)
  if (loadFailed) return <MediaLoadFailed label="语音加载失败，请刷新重试" />
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-line bg-surface px-3 py-2">
      {/*
        biome-ignore lint/a11y/useMediaCaption: 语音是用户自己录的音频，客户端拿不到
        转写内容，无法生成有意义的字幕轨。
      */}
      <audio
        className="h-9 w-60"
        controls
        onError={() => setLoadFailed(true)}
        preload="metadata"
        src={media.url}
      />
      <span className="text-[11px] text-ink-3">语音 {formatVoiceDuration(media.durationMs)}</span>
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
          {errorCode === 'IDEMPOTENCY_KEY_REUSED' || errorCode === 'USER_RESTRICTED' ? null : (
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
