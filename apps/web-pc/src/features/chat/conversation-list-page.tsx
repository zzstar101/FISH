import type { ConversationDto } from '@fish/contracts/chat/schema'
import { Button } from '@fish/ui/button'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import {
  invalidateConversationDetail,
  invalidateConversationSurfaces,
  useConversationList,
  useConversationUnreadCount,
} from './queries'
import { useChatRealtime } from './realtime'
import { systemMessageText } from './view'

function lastMessagePreview(item: ConversationDto, ownerId: string | null): string {
  const message = item.lastMessage
  if (message === null) return '还没有消息，打个招呼吧'
  const prefix = message.senderId === ownerId ? '我：' : ''
  const content = message.type === 'SYSTEM' ? systemMessageText(message.content) : message.content
  return `${prefix}${content}`
}

export function ConversationListPage() {
  const { me } = useAuth()
  const ownerId = me?.id ?? null
  const queryClient = useQueryClient()
  const conversations = useConversationList(ownerId)
  const unreadCount = useConversationUnreadCount(ownerId)

  useChatRealtime(ownerId, {
    onEvent: (event) => {
      if (ownerId === null) return
      if (event.type === 'message.new' || event.type === 'conversation.read') {
        invalidateConversationDetail(queryClient, ownerId, event.conversationId)
        invalidateConversationSurfaces(queryClient, ownerId)
      }
    },
    onOpen: () => {
      if (ownerId === null) return
      invalidateConversationSurfaces(queryClient, ownerId)
    },
  })

  const items = conversations.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">消息</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            {unreadCount.data === undefined || unreadCount.data === 0
              ? '与卖家或买家的全部会话'
              : `${unreadCount.data} 条未读消息`}
          </p>
        </div>
        <p className="text-ink-3 text-xs">实时刷新 · 每页 50 条</p>
      </div>

      {conversations.isPending ? <LoadingState label="正在加载会话…" /> : null}
      {conversations.isError && !conversations.isFetchNextPageError ? (
        <ErrorState message="会话列表加载失败" onRetry={() => void conversations.refetch()} />
      ) : null}
      {conversations.isSuccess && items.length === 0 ? (
        <EmptyState
          action={
            <Button asChild variant="outline">
              <Link to="/search">
                <MessageCircle className="size-4" />
                去逛商品
              </Link>
            </Button>
          }
          description="在商品详情页点击「聊一聊」后，会话会出现在这里"
          emoji="💬"
          title="还没有会话"
        />
      ) : null}

      {items.length > 0 ? (
        <section aria-label="会话列表" className="space-y-3">
          {items.map((item) => (
            <Link
              className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-brand/40 hover:bg-surface-2"
              key={item.id}
              params={{ conversationId: item.id }}
              to="/messages/$conversationId"
            >
              <ListingThumb
                alt={item.listing.title}
                className="size-16 rounded-xl"
                coverUrl={item.listing.coverUrl}
                listingId={item.listing.id}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-4">
                  <p className="truncate font-semibold">{item.counterpart.nickname}</p>
                  <time className="shrink-0 text-ink-3 text-xs" dateTime={item.lastMessageAt}>
                    {formatRelativeTimeAt(item.lastMessageAt)}
                  </time>
                </div>
                <p className="mt-1 truncate text-ink-2 text-sm">
                  {lastMessagePreview(item, ownerId)}
                </p>
                <p className="mt-1 truncate text-ink-3 text-xs">{item.listing.title}</p>
              </div>
              {item.unreadCount > 0 ? (
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-white text-xs">
                  {item.unreadCount > 99 ? '99+' : item.unreadCount}
                </span>
              ) : null}
            </Link>
          ))}
        </section>
      ) : null}

      {conversations.isFetchNextPageError ? (
        <ErrorState message="更多会话加载失败" onRetry={() => void conversations.fetchNextPage()} />
      ) : null}
      {conversations.hasNextPage && !conversations.isFetchNextPageError ? (
        <div className="flex justify-center pt-2">
          <Button
            disabled={conversations.isFetchingNextPage}
            onClick={() => void conversations.fetchNextPage()}
            variant="outline"
          >
            {conversations.isFetchingNextPage ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
