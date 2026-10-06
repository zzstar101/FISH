import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { Alert, AlertDescription } from '@fish/ui/alert'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import { NotificationRow } from './notification-row'
import {
  notificationReadErrorMessage,
  notificationTarget,
  notificationTargetErrorMessage,
} from './notification-view'
import {
  fetchCurrentListingTarget,
  fetchCurrentWishTarget,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from './queries'

export function NotificationsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { me } = useAuth()
  const meId = me?.id
  const notifications = useNotifications()
  const unread = useUnreadNotificationCount()
  const markRead = useMarkNotificationRead()
  const [actionError, setActionError] = useState<string | null>(null)
  const openEpochRef = useRef(0)
  const items = notifications.data?.items ?? []

  useEffect(() => {
    return () => {
      // 卸载后让所有在途的标记已读/目标确认流程失效，避免异步导航把用户拉回详情页。
      openEpochRef.current += 1
    }
  }, [])

  async function open(item: NotificationDto) {
    const epoch = openEpochRef.current + 1
    openEpochRef.current = epoch
    setActionError(null)
    if (item.readAt === null) {
      try {
        await markRead.mutateAsync(item.id)
      } catch (error) {
        if (epoch !== openEpochRef.current) return
        setActionError(notificationReadErrorMessage(error))
        return
      }
    }
    if (epoch !== openEpochRef.current) return

    const target = notificationTarget(item)
    if (target.kind === 'none') return

    // TX / MODERATION 直接跳（会话与「我的发布」都是静态路由，不需要先确认存在）；
    // 商品与愿望目标要先确认还可见，避免跳进一个已删/不属于该账号的资源页。
    if (target.kind === 'conversation') {
      await navigate({
        to: '/messages/$conversationId',
        params: { conversationId: target.conversationId },
      })
      return
    }
    if (target.kind === 'mylist') {
      await navigate({ to: '/mylist' })
      return
    }
    if (target.kind === 'wish') {
      await openWishTarget(target, epoch)
      return
    }

    await openListingTarget(target, epoch)
  }

  async function openWishTarget(
    target: Extract<ReturnType<typeof notificationTarget>, { kind: 'wish' }>,
    epoch: number,
  ) {
    if (meId === undefined) {
      setActionError(notificationTargetErrorMessage(target))
      return
    }
    try {
      const wish = await fetchCurrentWishTarget(queryClient, meId, target.wishId)
      if (epoch !== openEpochRef.current) return
      if (wish === null) {
        setActionError(notificationTargetErrorMessage(target))
        return
      }
      await navigate({ to: '/wish/$wishId', params: { wishId: target.wishId } })
    } catch {
      if (epoch !== openEpochRef.current) return
      setActionError('暂时无法确认目标愿望，已留在通知列表')
    }
  }

  async function openListingTarget(
    target: Extract<ReturnType<typeof notificationTarget>, { kind: 'listing' }>,
    epoch: number,
  ) {
    try {
      const detail = await fetchCurrentListingTarget(queryClient, target.listingId)
      if (epoch !== openEpochRef.current) return
      if (detail === null) {
        setActionError(notificationTargetErrorMessage(target))
        return
      }
      await navigate({ to: '/listing/$listingId', params: { listingId: target.listingId } })
    } catch {
      if (epoch !== openEpochRef.current) return
      setActionError('暂时无法确认目标商品，已留在通知列表')
    }
  }

  return (
    <div className="mx-auto max-w-[980px] space-y-5">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">通知中心</h1>
          <p className="mt-1.5 text-ink-3 text-sm">匹配结果和平台提醒会出现在这里。</p>
        </div>
        <p className="text-ink-3 text-xs">
          {unread.isPending
            ? '未读数加载中…'
            : unread.isError
              ? '未读数暂不可用'
              : `${unread.data} 条未读`}
        </p>
      </div>

      {actionError ? (
        <Alert variant="destructive">
          <Bell />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {notifications.isPending ? <LoadingState label="正在加载通知…" /> : null}
      {notifications.isError ? (
        <ErrorState message="通知加载失败" onRetry={() => void notifications.refetch()} />
      ) : null}

      {notifications.isSuccess && items.length === 0 ? (
        <EmptyState
          description="愿望匹配上闲置、平台有进展时会出现在这里"
          emoji="🔔"
          title="还没有通知"
        />
      ) : null}

      {notifications.isSuccess && items.length > 0 ? (
        <Card className="gap-0 overflow-hidden border border-line p-0">
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id}>
                <NotificationRow item={item} onOpen={(item) => void open(item)} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
