import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { Check, ChevronRight } from 'lucide-react'
import { formatChatTime, formatPrice } from '../../lib/format'
import { AppShell } from '../navigation/app-shell'
import { useConversations, useMarkAllRead, useNotifications } from './queries'

/** 消息页（#9）：通知 + 聊天列表。 */
export function MessagePage() {
  const conversations = useConversations()
  const notifications = useNotifications()
  const markAllRead = useMarkAllRead()

  return (
    <AppShell>
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar
          right={
            <button
              aria-label="全部已读"
              className="flex size-9 items-center justify-center text-ink disabled:opacity-40"
              disabled={notifications.data?.allRead !== false}
              onClick={() => markAllRead.mutate()}
              type="button"
            >
              <Check className="size-5" />
            </button>
          }
          title="消息"
        />
      </div>

      <section className="bg-surface">
        <h2 className="flex items-center justify-between px-4 pt-3 pb-2 font-semibold text-[15px]">
          通知
          <span className="font-normal text-ink-3 text-xs">
            {notifications.data?.allRead ? '已全部读完' : '全部已读'}
          </span>
        </h2>
        <ul>
          {notifications.data?.items.map((item) => (
            <li key={item.id}>
              <Link
                className="flex items-center gap-3 px-4 py-3"
                params={{ conversationId: item.conversationId }}
                to="/chat/$conversationId"
              >
                <Thumb
                  className="size-11 rounded-full"
                  emoji={item.emoji}
                  emojiClassName="text-xl"
                  tone={item.tone}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[15px]">{item.title}</p>
                  <p className="mt-0.5 truncate text-ink-3 text-xs">{item.description}</p>
                </div>
                <ChevronRight className="size-[18px] shrink-0 text-ink-3" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-2 bg-surface pb-2">
        <h2 className="flex items-center justify-between px-4 pt-3 pb-1 font-semibold text-[15px]">
          聊天
          <span className="font-normal text-ink-3 text-xs">
            {conversations.data?.reduce((sum, item) => sum + item.unread, 0) ?? 0} 条未读
          </span>
        </h2>

        {conversations.isPending ? <LoadingState /> : null}
        {conversations.isError ? (
          <ErrorState message="会话加载失败" onRetry={() => void conversations.refetch()} />
        ) : null}
        {conversations.data?.filter((item) => item.kind === 'peer').length === 0 ? (
          <EmptyState description="还没有会话,去详情页找同学聊聊吧" emoji="💬" />
        ) : null}

        <ul className="divide-y divide-line">
          {conversations.data
            ?.filter((item) => item.kind === 'peer')
            .map((item) => {
              const last = item.messages.at(-1)
              return (
                <li key={item.id}>
                  <Link
                    className="flex gap-3 px-4 py-3"
                    params={{ conversationId: item.id }}
                    to="/chat/$conversationId"
                  >
                    <div className="relative shrink-0">
                      <UserAvatar
                        emoji={item.peer?.emoji ?? '🔔'}
                        size="lg"
                        tone={item.peer?.tone ?? 'warn'}
                      />
                      {item.unread > 0 ? (
                        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-white">
                          {item.unread}
                        </span>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-semibold text-[15px]">{item.title}</span>
                        <span className="shrink-0 text-ink-3 text-xs">
                          {formatChatTime(item.updatedMinutesAgo)}
                        </span>
                      </div>
                      {item.listing ? (
                        <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-surface-2 px-2 py-1.5">
                          <Thumb
                            className="size-8 rounded-md"
                            emoji={item.listing.emoji}
                            emojiClassName="text-base"
                            tone={item.listing.tone}
                          />
                          <span className="min-w-0 flex-1 truncate text-ink-2 text-xs">
                            {item.listing.title}
                          </span>
                          <span className="shrink-0 font-medium text-xs">
                            {formatPrice(item.listing.priceCents)}
                          </span>
                        </div>
                      ) : null}
                      <p className="mt-1.5 truncate text-ink-3 text-sm">
                        {last?.text ?? '打个招呼吧'}
                      </p>
                    </div>
                  </Link>
                </li>
              )
            })}
        </ul>
      </section>
    </AppShell>
  )
}
