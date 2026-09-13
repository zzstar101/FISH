import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { ChevronLeft, Send, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { ApiError } from '../../lib/api-client'
import { formatClockAt, formatMessageDayAt, formatPrice } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import {
  useAcceptTransaction,
  useProposeTransaction,
  useRejectTransaction,
} from '../transaction/queries'
import {
  meta,
  useConversations,
  useMarkConversationRead,
  useMessages,
  useSendMessage,
} from './queries'
import { formatMessageBody, lastTransactionEvent } from './system-event'

/**
 * 聊天详情（#9，#41 接真实）：历史消息走 HTTP，新消息走 `/ws/chat` 推送，
 * 断线重连后由 realtime 层失效缓存、从历史接口恢复。
 */
export function ChatPage({ conversationId }: { conversationId: string }) {
  const { me } = useAuth()
  const conversations = useConversations()
  const messages = useMessages(conversationId)
  const send = useSendMessage(conversationId)
  const markRead = useMarkConversationRead(conversationId)
  const propose = useProposeTransaction()
  const accept = useAcceptTransaction()
  const reject = useRejectTransaction()
  const [draft, setDraft] = useState('')
  /** 交易动作的行内错误（409 LISTING_NOT_ACTIVE 等），渲染在商品卡下。 */
  const [actionError, setActionError] = useState('')

  // 打开会话即标记已读（服务端推进 last_read_at，未读角标随之归零）。
  // mutate 引用稳定，effect 只在进入会话时执行一次。
  useEffect(() => {
    markRead.mutate()
  }, [markRead.mutate])

  if (conversations.isPending || messages.isPending) {
    return (
      <div className="min-h-dvh bg-bg">
        <ChatHeader title="会话" />
        <LoadingState />
      </div>
    )
  }

  const item = conversations.data?.find((conversation) => conversation.id === conversationId)
  // 新建会话后立即跳转时列表缓存还没有这条会话：正在拉取就先给 loading，
  // 拉完仍没有才是真的「不存在」（会话列表是分页首屏，深链旧会话同理）。
  if (!item && conversations.isFetching) {
    return (
      <div className="min-h-dvh bg-bg">
        <ChatHeader title="会话" />
        <LoadingState />
      </div>
    )
  }
  if (conversations.isError || !item) {
    return (
      <div className="min-h-dvh bg-bg">
        <ChatHeader title="会话" />
        <EmptyState
          description={conversations.isError ? '会话加载失败,请返回重试' : '会话不存在'}
          emoji="💬"
        />
      </div>
    )
  }

  // 历史消息拉取失败不能伪装成「还没有消息」：明确给错误与重试。
  if (messages.isError) {
    return (
      <div className="min-h-dvh bg-bg">
        <ChatHeader title="会话" />
        <ErrorState message="消息加载失败" onRetry={() => void messages.refetch()} />
      </div>
    )
  }

  const list = messages.data ?? []
  const isSeller = item.role === 'seller'
  const canTrade = item.listing.status === 'ACTIVE'
  // 交易动作（#11）：买家发起提案——最后事件已是提案时不再重复发起
  // （提案不落库，消息流就是唯一事实来源，#11 把防抖责任交给前端）；
  // 卖家只对「最后事件是 proposal」的会话给出接受/拒绝。
  const lastTxEvent = lastTransactionEvent(list)
  const canPropose = canTrade && !isSeller && lastTxEvent?.type !== 'tx.proposal'
  const canRespond = canTrade && isSeller && lastTxEvent?.type === 'tx.proposal'
  const proposalAmount =
    lastTxEvent?.type === 'tx.proposal' ? lastTxEvent.amountCents : item.listing.priceCents

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
            <span className="truncate font-semibold text-[17px]">{item.counterpart.nickname}</span>
          </div>
          <Link
            aria-label="TA 的主页"
            className="flex size-9 items-center justify-center text-ink-2"
            params={{ userId: item.counterpart.id }}
            to="/user/$userId"
          >
            <User className="size-5" />
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {/*
          只有 ACTIVE 商品能发起交易：详情页对非 ACTIVE 已禁用 CTA，
          聊天页是另一条入口，这里再挡一次（实测确认过能绕过）。
        */}
        {actionError ? (
          <p className="mx-3 mt-2 rounded-xl bg-danger-soft px-3 py-2 text-danger text-xs">
            {actionError}
          </p>
        ) : null}
        <div className="mx-3 mt-2 flex items-center gap-2.5 rounded-xl bg-surface p-2.5">
          <Link
            className="flex min-w-0 flex-1 items-center gap-2.5"
            params={{ listingId: item.listing.id }}
            to="/detail/$listingId"
          >
            <ListingThumb
              alt={item.listing.title}
              className="size-11 rounded-lg"
              coverUrl={item.listing.coverUrl}
              listingId={item.listing.id}
              emojiClassName="text-xl"
            />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-sm">{item.listing.title}</p>
              <p className="mt-0.5 flex items-center gap-1.5 font-semibold text-sm">
                {formatPrice(item.listing.priceCents)}
                {canTrade ? null : <Badge variant="secondary">不可交易</Badge>}
              </p>
            </div>
          </Link>
          {canPropose ? (
            <Button
              className="shrink-0"
              disabled={propose.isPending}
              onClick={() => {
                setActionError('')
                propose.mutate(
                  { amountCents: item.listing.priceCents, conversationId: item.id },
                  { onError: (error) => setActionError(error.message) },
                )
              }}
              size="sm"
            >
              发起交易
            </Button>
          ) : null}
          {canRespond ? (
            <div className="flex shrink-0 gap-1.5">
              <Button
                disabled={accept.isPending || reject.isPending}
                onClick={() => {
                  setActionError('')
                  // 409 LISTING_NOT_ACTIVE 可能是「上次接受已成功」：提示以会话/订单为准。
                  accept.mutate(
                    { amountCents: proposalAmount, conversationId: item.id },
                    {
                      onError: (error) =>
                        setActionError(
                          error instanceof ApiError && error.code === 'LISTING_NOT_ACTIVE'
                            ? '商品当前不可交易；若你刚点过接受，请以聊天记录或订单页为准'
                            : error.message,
                        ),
                    },
                  )
                }}
                size="sm"
              >
                接受
              </Button>
              <Button
                disabled={accept.isPending || reject.isPending}
                onClick={() => {
                  setActionError('')
                  reject.mutate(item.id, { onError: (error) => setActionError(error.message) })
                }}
                size="sm"
                variant="destructive"
              >
                拒绝
              </Button>
            </div>
          ) : null}
        </div>

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

        <p className="py-3 text-center text-ink-3 text-xs">
          {list.length > 0
            ? formatMessageDayAt(list[list.length - 1]?.createdAt ?? item.lastMessageAt)
            : formatMessageDayAt(item.lastMessageAt)}
        </p>

        <ul className="space-y-3 px-3">
          {list.map((message) => {
            // SYSTEM 消息（#9 工作项）：没有发送者，渲染为居中的灰色系统条；
            // 内容按 #11 的 tx.* 协议解析（见 system-event.ts），失败降级为原文。
            if (message.type === 'SYSTEM') {
              return (
                <li className="flex justify-center" key={message.id}>
                  <p className="max-w-[86%] rounded-full bg-surface-2 px-3.5 py-1.5 text-center text-ink-3 text-xs leading-relaxed">
                    {formatMessageBody(message)}
                  </p>
                </li>
              )
            }
            const mine = message.senderId === me?.id
            return (
              <li className={`flex gap-2 ${mine ? 'justify-end' : ''}`} key={message.id}>
                {mine ? null : (
                  <UserAvatar
                    avatarUrl={item.counterpart.avatarUrl}
                    emoji={item.counterpart.nickname.slice(0, 1)}
                    size="sm"
                  />
                )}
                <div className={`flex max-w-[74%] flex-col ${mine ? 'items-end' : ''}`}>
                  <p
                    className={`rounded-2xl px-3 py-2 text-[15px] leading-snug whitespace-pre-wrap ${
                      mine ? 'bg-brand text-white' : 'bg-surface text-ink'
                    }`}
                  >
                    {message.content}
                  </p>
                  <span className="mt-1 text-ink-3 text-xs">
                    {formatClockAt(message.createdAt)}
                  </span>
                </div>
                {mine ? (
                  <UserAvatar
                    avatarUrl={me?.avatarUrl ?? null}
                    emoji={me?.nickname.slice(0, 1) ?? '我'}
                    size="sm"
                  />
                ) : null}
              </li>
            )
          })}
          {list.length === 0 ? (
            <li className="text-center text-ink-3 text-sm">还没有消息,打个招呼吧</li>
          ) : null}
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
          placeholder="打个招呼吧…"
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
