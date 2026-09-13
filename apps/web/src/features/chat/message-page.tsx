import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { Bell, Check, ChevronRight } from 'lucide-react'
import { formatChatTime, formatPrice } from '../../lib/format'
import { AppShell } from '../navigation/app-shell'
import {
  useConversations,
  useMarkAllRead,
  useNotificationBadge,
  useUnreadNotificationCount,
} from './queries'
import { formatMessageBody } from './system-event'

/**
 * 消息页（#9）：置顶的「系统通知」入口 + 聊天列表。
 *
 * #23 把通知的形态定成「消息 tab 顶部置顶一行」：通知**不再**平铺在这里，
 * 而是点进独立的通知列表页（`/notifications`）。这样会话列表的滚动区域完整，
 * 置顶行也不会随列表滚走。
 */
export function MessagePage() {
  const conversations = useConversations()
  const badge = useNotificationBadge()
  const unreadNotifications = useUnreadNotificationCount()
  const markAllRead = useMarkAllRead()
  const unreadChats = conversations.data?.reduce((sum, item) => sum + item.unread, 0) ?? 0

  return (
    <AppShell>
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar
          right={
            <button
              aria-label="全部已读"
              className="flex size-9 items-center justify-center text-ink disabled:opacity-40"
              disabled={badge.data === 0}
              onClick={() => markAllRead.mutate()}
              type="button"
            >
              <Check className="size-5" />
            </button>
          }
          title="消息"
        />
      </div>

      {/* #23 的置顶行：固定在会话列表上方，右侧红点取自未读总数。 */}
      <section className="bg-surface">
        <Link className="flex items-center gap-3 px-4 py-3" to="/notifications">
          <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-soft">
            <Bell className="size-5 text-brand" />
            {unreadNotifications.data ? (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-white">
                {unreadNotifications.data > 99 ? '99+' : unreadNotifications.data}
              </span>
            ) : null}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[15px]">系统通知</p>
            <p className="mt-0.5 truncate text-ink-3 text-xs">
              {unreadNotifications.data ? `${unreadNotifications.data} 条未读` : '暂无未读通知'}
            </p>
          </div>
          <ChevronRight className="size-[18px] shrink-0 text-ink-3" />
        </Link>
      </section>

      <section className="mt-2 bg-surface pb-2">
        <h2 className="flex items-center justify-between px-4 pt-3 pb-1 font-semibold text-[15px]">
          聊天
          <span className="font-normal text-ink-3 text-xs">{unreadChats} 条未读</span>
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
                        {last ? formatMessageBody(last) : '打个招呼吧'}
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
