import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { formatRelativeTime } from '../../lib/format'
import { useMarkNotificationRead, useNotifications } from '../chat/queries'

/**
 * 通知列表页（#23）。
 *
 * 每条 = 未读点 + 文案 + 相对时间。文案与跳转目标都**不由本组件拼**：
 * 服务端只存 `type` + `payload`，组装在 store 的 adapter 里（`decorateNotification`），
 * 所以改文案 / 加新 type 都不用动这里。
 *
 * 已读策略（#23 要求「进入或点击后标记已读」二选一，这里选**点击后**）：
 * 进页面就全标已读的话，用户退出去看到红点没了，却不知道自己漏了哪条。
 */
export function NotificationsPage() {
  const navigate = useNavigate()
  const notifications = useNotifications()
  const markRead = useMarkNotificationRead()
  const items = notifications.data?.items ?? []
  const unread = items.filter((item) => !item.read).length

  const open = (id: string, target: (typeof items)[number]['target']) => {
    // 幂等：已读再点不会重复请求。标记与跳转并行，不因为等待而卡住点击。
    markRead.mutate(id)
    if (!target) return
    if (target.to === '/detail/$listingId') {
      void navigate({ to: '/detail/$listingId', params: { listingId: target.listingId } })
      return
    }
    void navigate({ to: target.to })
  }

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="系统通知" />
      </div>

      {notifications.isPending ? <LoadingState /> : null}
      {notifications.isError ? (
        <ErrorState message="通知加载失败" onRetry={() => void notifications.refetch()} />
      ) : null}
      {!notifications.isPending && items.length === 0 ? (
        <EmptyState description="愿望匹配上闲置、交易有进展时会出现在这里" emoji="🔔" />
      ) : null}

      {items.length > 0 ? (
        <p className="px-4 py-3 text-ink-3 text-xs">
          {unread > 0 ? `${unread} 条未读` : '已全部读完'}
        </p>
      ) : null}

      <ul className="divide-y divide-line bg-surface">
        {items.map((item) => (
          <li key={item.id}>
            <button
              className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
              onClick={() => open(item.id, item.target)}
              type="button"
            >
              <span className="relative mt-1 flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-soft">
                <span aria-hidden className="text-xl leading-none">
                  {item.emoji}
                </span>
                {/* 未读点：已读后消失（服务端的 unread-count 与这里同源）。 */}
                {item.read ? null : (
                  <span className="absolute top-0 right-0 size-2.5 rounded-full bg-danger ring-2 ring-surface" />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-[15px]">{item.title}</span>
                  <span className="shrink-0 text-ink-3 text-xs">
                    {formatRelativeTime(item.minutesAgo)}
                  </span>
                </p>
                <p className="mt-1 line-clamp-2 text-ink-2 text-sm leading-snug">
                  {item.description}
                </p>
              </div>

              {item.target ? (
                <ChevronRight className="mt-3 size-[18px] shrink-0 text-ink-3" />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
