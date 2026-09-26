import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../features/shell/page-placeholder'

export const Route = createFileRoute('/notifications')({ component: NotificationsPage })

function NotificationsPage() {
  return (
    <PagePlaceholder
      actionLabel="返回首页"
      description="通知路由已接通。通知列表、未读数和匹配通知跳转将在通知主链 Issue 接入。"
      title="通知中心"
    />
  )
}
