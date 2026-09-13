import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronLeft, Send, User } from 'lucide-react'
import { useState } from 'react'
import { formatClock, formatMessageDay, formatPrice } from '../../lib/format'
import type { ListingStatus } from '../../lib/mock/types'
import { useRequestOrder } from '../transaction/queries'
import { meta, useConversation, useSendMessage } from './queries'
import { formatMessageBody } from './system-event'

/**
 * 商品状态文案。聊天页只区分「能否交易」，所以这里只需一句可读的状态说明；
 * 完整的状态标签映射在商品详情页（`listing-detail/detail-page.tsx`）。
 */
const LISTING_STATUS_LABEL: Record<ListingStatus, string> = {
  ACTIVE: '',
  RESERVED: '已预定',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

/** 聊天详情（#9）：TEXT 气泡 + 系统会话 + 商品卡 + 快捷短语。 */
export function ChatPage({ conversationId }: { conversationId: string }) {
  const navigate = useNavigate()
  const conversation = useConversation(conversationId)
  const send = useSendMessage(conversationId)
  const requestOrder = useRequestOrder()
  const [draft, setDraft] = useState('')

  if (conversation.isPending) {
    return (
      <div className="min-h-dvh bg-bg">
        <ChatHeader title="会话" />
        <LoadingState />
      </div>
    )
  }
  if (conversation.isError || !conversation.data) {
    return (
      <div className="min-h-dvh bg-bg">
        <ChatHeader title="会话" />
        <EmptyState
          description={conversation.isError ? '会话加载失败,请返回重试' : '会话不存在'}
          emoji="💬"
        />
      </div>
    )
  }

  const item = conversation.data
  const isSystem = item.kind === 'system'
  /**
   * 只有 ACTIVE 商品能发起交易。
   *
   * 详情页对非 ACTIVE 已禁用 CTA，但聊天页是另一条入口——不在这里挡住，
   * 用户就能从会话里绕过详情页、对已下架/已售出的商品下单（实测确认过）。
   */
  const canTrade = item.listing?.status === 'ACTIVE'

  const submit = (text: string) => {
    const value = text.trim()
    if (!value) return
    send.mutate(value, { onSuccess: () => setDraft('') })
  }

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="sticky top-0 z-20 shrink-0 bg-surface">
        <div className="flex h-11 items-center pr-3">
          <button
            aria-label="返回"
            className="flex size-11 items-center justify-center text-ink"
            onClick={() => window.history.back()}
            type="button"
          >
            <ChevronLeft className="size-6" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate font-semibold text-[17px]">{item.title}</span>
            {isSystem ? <Badge variant="secondary">官方</Badge> : null}
          </div>
          {item.peer ? (
            <Link
              aria-label="TA 的主页"
              className="flex size-9 items-center justify-center text-ink-2"
              params={{ userId: item.peer.id }}
              to="/user/$userId"
            >
              <User className="size-5" />
            </Link>
          ) : null}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {isSystem ? (
          <p className="py-3 text-center text-ink-3 text-xs">与 校园小助手 的对话</p>
        ) : null}

        {item.listing ? (
          <div className="mx-3 mt-2 flex items-center gap-2.5 rounded-xl bg-surface p-2.5">
            <Link
              className="flex min-w-0 flex-1 items-center gap-2.5"
              params={{ listingId: item.listing.id }}
              to="/detail/$listingId"
            >
              <Thumb
                className="size-11 rounded-lg"
                emoji={item.listing.emoji}
                emojiClassName="text-xl"
                tone={item.listing.tone}
              />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm">{item.listing.title}</p>
                <p className="mt-0.5 flex items-center gap-1.5 font-semibold text-sm">
                  {formatPrice(item.listing.priceCents)}
                  {canTrade ? null : (
                    <Badge variant="secondary">{LISTING_STATUS_LABEL[item.listing.status]}</Badge>
                  )}
                </p>
              </div>
            </Link>
            <Button
              className="shrink-0"
              disabled={requestOrder.isPending || !canTrade}
              onClick={() =>
                requestOrder.mutate(item.listing?.id ?? '', {
                  onSuccess: () => void navigate({ to: '/orders' }),
                })
              }
              size="sm"
            >
              {canTrade ? '发起交易' : '不可交易'}
            </Button>
          </div>
        ) : null}

        {isSystem ? null : (
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-3 pb-1">
            {meta.chatQuickPhrases.map((phrase) => (
              <button
                className="shrink-0 rounded-full bg-surface px-3 py-1.5 text-ink-2 text-xs"
                key={phrase}
                onClick={() => submit(phrase)}
                type="button"
              >
                {phrase}
              </button>
            ))}
          </div>
        )}

        <p className="py-3 text-center text-ink-3 text-xs">
          {formatMessageDay(item.messages.at(-1)?.sentAtMinutesAgo ?? 0)}
        </p>

        <ul className="space-y-3 px-3">
          {item.messages.map((message) => {
            // SYSTEM 消息（#9 工作项）：没有发送者，渲染为居中的灰色系统条；
            // 内容按 #11 的 tx.* 协议解析（见 system-event.ts），失败降级为原文。
            if (message.kind === 'SYSTEM') {
              return (
                <li className="flex justify-center" key={message.id}>
                  <p className="max-w-[86%] rounded-full bg-surface-2 px-3.5 py-1.5 text-center text-ink-3 text-xs leading-relaxed">
                    {formatMessageBody(message)}
                  </p>
                </li>
              )
            }
            const mine = message.from === 'me'
            return (
              <li className={`flex gap-2 ${mine ? 'justify-end' : ''}`} key={message.id}>
                {mine ? null : (
                  <UserAvatar
                    emoji={item.peer?.emoji ?? '🔔'}
                    size="sm"
                    tone={item.peer?.tone ?? 'warn'}
                  />
                )}
                <div className={`flex max-w-[74%] flex-col ${mine ? 'items-end' : ''}`}>
                  <p
                    className={`rounded-2xl px-3 py-2 text-[15px] leading-snug ${
                      mine ? 'bg-brand text-white' : 'bg-surface text-ink'
                    }`}
                  >
                    {message.text}
                  </p>
                  <span className="mt-1 text-ink-3 text-xs">
                    {formatClock(message.sentAtMinutesAgo)}
                  </span>
                </div>
                {mine ? (
                  <UserAvatar emoji={item.self.emoji} size="sm" tone={item.self.tone} />
                ) : null}
              </li>
            )
          })}
        </ul>

        {send.isSuccess ? <p className="pr-4 pt-3 text-right text-ink-3 text-xs">已发送</p> : null}
      </div>

      <form
        className="pb-safe sticky bottom-0 z-20 flex shrink-0 items-center gap-2 border-line border-t bg-surface px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit(draft)
        }}
      >
        <Input
          className="h-10 min-w-0 flex-1 rounded-full border-0 px-4"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={isSystem ? '有什么想问的…' : '打个招呼吧…'}
          value={draft}
        />
        <Button aria-label="发送" disabled={send.isPending} type="submit">
          <Send />
          发送
        </Button>
      </form>
    </div>
  )
}

/** 会话还没到手（加载中 / 失败 / 不存在）时的最小导航条，保证还能返回。 */
function ChatHeader({ title }: { title: string }) {
  return (
    <header className="flex h-11 items-center bg-surface">
      <button
        aria-label="返回"
        className="flex size-11 items-center justify-center text-ink"
        onClick={() => window.history.back()}
        type="button"
      >
        <ChevronLeft className="size-6" />
      </button>
      <span className="font-semibold text-[17px]">{title}</span>
    </header>
  )
}
