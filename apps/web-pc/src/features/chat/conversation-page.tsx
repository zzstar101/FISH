import type { MessageDto } from '@fish/contracts/chat/schema'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Textarea } from '@fish/ui/textarea'
import { UserAvatar } from '@fish/ui/user-avatar'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Send } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { ApiError } from '../../lib/api-client'
import { useAuth } from '../auth/auth-provider'
import { describeSendFailure } from './api'
import { MessageBubble, type OutboxMessage, PendingMessageBubble } from './message-bubble'
import {
  applyReadEventToCache,
  flattenMessagePages,
  insertMessageIntoCache,
  invalidateConversationSurfaces,
  isMessageRead,
  mergeMessagesIntoCache,
  probeChatSession,
  refreshConversationOnReconnect,
  useConversation,
  useMarkConversationRead,
  useMessageHistory,
  useSendTextMessage,
} from './queries'
import { type ChatRealtimeStatus, useChatRealtime } from './realtime'

const STATUS_LABEL: Record<ListingStatus, string> = {
  ACTIVE: '在售',
  RESERVED: '已预定',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

function RealtimeStatus({ status }: { status: ChatRealtimeStatus }) {
  if (status === 'open') {
    return (
      <span className="inline-flex items-center gap-1.5 text-success text-xs">
        <span className="size-1.5 rounded-full bg-success" />
        实时连接正常
      </span>
    )
  }
  if (status === 'reconnecting') {
    return (
      <span className="inline-flex items-center gap-1.5 text-warn text-xs">
        <span className="size-1.5 rounded-full bg-warn" />
        连接已断开，正在重连…
      </span>
    )
  }
  return null
}

export function ConversationPage({ conversationId }: { conversationId: string }) {
  const { me } = useAuth()
  const ownerId = me?.id ?? null
  const queryClient = useQueryClient()
  const conversation = useConversation(ownerId, conversationId)
  const history = useMessageHistory(ownerId, conversationId)
  const markRead = useMarkConversationRead(ownerId)
  const sendMessage = useSendTextMessage(ownerId)
  const [draft, setDraft] = useState('')
  const [outbox, setOutbox] = useState<OutboxMessage[]>([])
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [localMessages, setLocalMessages] = useState<MessageDto[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const markReadRef = useRef(markRead)
  markReadRef.current = markRead
  const sendRef = useRef(sendMessage)
  sendRef.current = sendMessage
  const historyErrorRef = useRef(false)
  const recoveryGenerationRef = useRef(0)
  historyErrorRef.current = history.isError
  const liveRef = useRef<{ conversationId: string; messages: Map<string, MessageDto> }>({
    conversationId,
    messages: new Map(),
  })
  if (liveRef.current.conversationId !== conversationId) {
    liveRef.current = { conversationId, messages: new Map() }
  }
  const mergeLiveRef = useRef<() => void>(() => {})
  mergeLiveRef.current = () => {
    if (ownerId === null) return
    mergeMessagesIntoCache(queryClient, ownerId, conversationId, [
      ...liveRef.current.messages.values(),
    ])
  }
  useEffect(() => {
    if (history.isFetching || history.isError) return
    mergeLiveRef.current()
    setLocalMessages([])
  }, [history.isFetching, history.isError])

  const messages = useMemo(() => flattenMessagePages(history.data), [history.data])
  const counterpartLastReadAt = conversation.data?.counterpartLastReadAt ?? null

  const realtimeStatus = useChatRealtime(ownerId, {
    onEvent: (event) => {
      if (ownerId === null) return
      if (event.type === 'message.new') {
        if (event.conversationId === conversationId) {
          rememberMessage(event.message)
          if (event.message.senderId !== ownerId) {
            markReadRef.current.mutate(conversationId)
          }
        }
        invalidateConversationSurfaces(queryClient, ownerId)
        return
      }
      if (event.type === 'conversation.read') {
        applyReadEventToCache(queryClient, ownerId, event)
        invalidateConversationSurfaces(queryClient, ownerId)
      }
    },
    onOpen: () => {
      if (ownerId === null) return
      recoverAfterReconnect()
      invalidateConversationSurfaces(queryClient, ownerId)
    },
    onDisconnected: () => {
      if (ownerId === null) return
      probeChatSession(queryClient, ownerId)
    },
  })

  useEffect(() => {
    if (ownerId === null || conversation.data === undefined || conversation.data === null) return
    if (conversation.data.unreadCount === 0) return
    markReadRef.current.mutate(conversationId)
  }, [conversation.data, conversationId, ownerId])

  const lastMessageId = messages.at(-1)?.id ?? null
  const scrollSignal = `${conversationId}:${lastMessageId ?? ''}:${outbox.length}`
  useEffect(() => {
    const node = scrollRef.current
    if (node === null || scrollSignal.length === 0) return
    node.scrollTop = node.scrollHeight
  }, [scrollSignal])

  function rememberMessage(message: MessageDto) {
    if (ownerId === null) return
    liveRef.current.messages.set(message.id, message)
    // 历史 query 处于错误态时不能写伪页，否则会把可重试的 error 改成 success；
    // 消息留在 liveRef，等用户/重连把历史拉成功后再合并。
    if (historyErrorRef.current) {
      setLocalMessages((current) =>
        current.some((item) => item.id === message.id) ? current : [...current, message],
      )
      return
    }
    insertMessageIntoCache(queryClient, ownerId, conversationId, message)
  }

  function recoverAfterReconnect() {
    if (ownerId === null) return
    const generation = recoveryGenerationRef.current + 1
    recoveryGenerationRef.current = generation
    setRecoveryError(null)
    void refreshConversationOnReconnect(queryClient, ownerId, conversationId)
      .then(() => {
        if (recoveryGenerationRef.current !== generation) return
        mergeLiveRef.current()
      })
      .catch(() => {
        if (recoveryGenerationRef.current !== generation) return
        setRecoveryError('断线后的历史补拉失败，请重试')
      })
  }

  function dispatch(item: OutboxMessage) {
    if (ownerId === null) return
    sendRef.current.mutate(
      {
        conversationId,
        input: { content: item.content, clientRequestId: item.clientRequestId },
      },
      {
        onSuccess: (message) => {
          rememberMessage(message)
          setOutbox((current) =>
            current.filter((entry) => entry.clientRequestId !== item.clientRequestId),
          )
        },
        onError: (error) => {
          const errorCode = error instanceof ApiError ? error.code : null
          setOutbox((current) =>
            current.map((entry) =>
              entry.clientRequestId === item.clientRequestId
                ? {
                    ...entry,
                    status: 'failed',
                    error: describeSendFailure(error),
                    errorCode,
                  }
                : entry,
            ),
          )
        },
      },
    )
  }

  function submit() {
    const content = draft.trim()
    if (ownerId === null || content.length === 0 || content.length > 2000) return
    const item: OutboxMessage = {
      clientRequestId: crypto.randomUUID(),
      content,
      status: 'sending',
      error: null,
      errorCode: null,
    }
    setOutbox((current) => [...current, item])
    setDraft('')
    dispatch(item)
  }

  function retry(item: OutboxMessage) {
    setOutbox((current) =>
      current.map((entry) =>
        entry.clientRequestId === item.clientRequestId
          ? { ...entry, status: 'sending', error: null, errorCode: null }
          : entry,
      ),
    )
    dispatch(item)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  if (conversation.isPending) return <LoadingState label="正在加载会话…" />

  if (conversation.isError) {
    return <ErrorState message="会话加载失败" onRetry={() => void conversation.refetch()} />
  }

  if (conversation.data === null) {
    return (
      <EmptyState
        action={
          <Button asChild variant="outline">
            <Link to="/messages">返回消息列表</Link>
          </Button>
        }
        description="可能已被删除，或者当前账号无权查看"
        emoji="💬"
        title="会话不存在或不可访问"
      />
    )
  }

  const item = conversation.data

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            aria-label="返回消息列表"
            className="grid size-9 place-items-center rounded-lg border border-line bg-surface text-ink-2 transition-colors hover:text-brand"
            to="/messages"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="font-semibold text-[24px] tracking-[-0.03em]">
              {item.counterpart.nickname}
            </h1>
            <p className="mt-0.5 text-ink-3 text-xs">
              {item.role === 'buyer' ? '我是买家' : '我是卖家'}
            </p>
          </div>
        </div>
        <RealtimeStatus status={realtimeStatus} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-5">
        <Card className="gap-0 border border-line p-0">
          <div className="flex h-[calc(100dvh-230px)] min-h-[520px] flex-col">
            <div className="border-line border-b px-5 py-4">
              <Link
                className="flex items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-surface-2"
                params={{ listingId: item.listing.id }}
                to="/listing/$listingId"
              >
                <ListingThumb
                  alt={item.listing.title}
                  className="size-12 rounded-lg"
                  coverUrl={item.listing.coverUrl}
                  listingId={item.listing.id}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{item.listing.title}</p>
                  <p className="mt-0.5 text-ink-3 text-xs">
                    {STATUS_LABEL[item.listing.status]} · 点击查看商品
                  </p>
                </div>
                <PriceText
                  cents={item.listing.priceCents}
                  className="shrink-0 font-bold text-base"
                />
              </Link>
            </div>

            {recoveryError !== null ? (
              <div className="flex items-center justify-between gap-3 border-line border-b bg-warn-soft px-5 py-2 text-warn text-xs">
                <span>{recoveryError}</span>
                <button
                  className="font-medium hover:underline"
                  onClick={recoverAfterReconnect}
                  type="button"
                >
                  重试
                </button>
              </div>
            ) : null}

            <div className="flex-1 overflow-y-auto bg-surface-2/40 px-5 py-4" ref={scrollRef}>
              {history.isPending ? <LoadingState label="正在加载历史消息…" /> : null}
              {history.isError && !history.isFetchNextPageError ? (
                <ErrorState message="历史消息加载失败" onRetry={() => void history.refetch()} />
              ) : null}
              {history.isFetchNextPageError ? (
                <div className="mb-4">
                  <ErrorState
                    message="更早消息加载失败"
                    onRetry={() => void history.fetchNextPage()}
                  />
                </div>
              ) : null}
              {history.isSuccess && history.hasNextPage ? (
                <div className="mb-4 flex justify-center">
                  <Button
                    disabled={history.isFetchingNextPage}
                    onClick={() => void history.fetchNextPage()}
                    size="sm"
                    variant="outline"
                  >
                    {history.isFetchingNextPage ? '正在加载…' : '加载更早消息'}
                  </Button>
                </div>
              ) : null}
              {history.isSuccess && messages.length === 0 ? (
                <p className="py-10 text-center text-ink-3 text-sm">还没有消息，发一条打个招呼吧</p>
              ) : null}
              <div className="space-y-4">
                {messages.map((message) => (
                  <MessageBubble
                    isMine={message.senderId === ownerId}
                    isRead={isMessageRead(message, counterpartLastReadAt)}
                    key={message.id}
                    message={message}
                  />
                ))}
                {localMessages.map((message) => (
                  <MessageBubble
                    isMine={message.senderId === ownerId}
                    isRead={isMessageRead(message, counterpartLastReadAt)}
                    key={`local-${message.id}`}
                    message={message}
                  />
                ))}
                {outbox.map((entry) => (
                  <PendingMessageBubble
                    item={entry}
                    key={entry.clientRequestId}
                    onDismiss={() =>
                      setOutbox((current) =>
                        current.filter((item) => item.clientRequestId !== entry.clientRequestId),
                      )
                    }
                    onRetry={() => retry(entry)}
                  />
                ))}
              </div>
            </div>

            <div className="border-line border-t p-4">
              <div className="flex items-end gap-3">
                <Textarea
                  className="max-h-[160px] min-h-[44px] flex-1 resize-none"
                  maxLength={2000}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入消息，Enter 发送，Shift + Enter 换行"
                  value={draft}
                />
                <Button
                  className="h-11"
                  disabled={draft.trim().length === 0 || sendMessage.isPending}
                  onClick={submit}
                  type="button"
                >
                  <Send className="size-4" />
                  发送
                </Button>
              </div>
              <p className="mt-2 text-right text-ink-3 text-xs">{draft.length}/2000</p>
            </div>
          </div>
        </Card>

        <aside className="sticky top-24 space-y-4">
          <Card className="gap-0 border border-line p-5">
            <h2 className="font-semibold text-base">商品</h2>
            <Link
              className="mt-4 flex gap-3 rounded-xl p-2 transition-colors hover:bg-surface-2"
              params={{ listingId: item.listing.id }}
              to="/listing/$listingId"
            >
              <ListingThumb
                alt={item.listing.title}
                className="size-16 rounded-xl"
                coverUrl={item.listing.coverUrl}
                listingId={item.listing.id}
              />
              <div className="min-w-0">
                <p className="line-clamp-2 font-medium text-sm">{item.listing.title}</p>
                <PriceText
                  cents={item.listing.priceCents}
                  className="mt-2 block font-bold text-lg"
                />
                <p className="mt-1 text-ink-3 text-xs">{STATUS_LABEL[item.listing.status]}</p>
              </div>
            </Link>
          </Card>

          <Card className="gap-0 border border-line p-5">
            <h2 className="font-semibold text-base">对方</h2>
            <div className="mt-4 flex items-center gap-3">
              <UserAvatar
                avatarUrl={item.counterpart.avatarUrl}
                emoji={item.counterpart.nickname.slice(0, 1)}
                size="lg"
              />
              <p className="truncate font-semibold">{item.counterpart.nickname}</p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  )
}
