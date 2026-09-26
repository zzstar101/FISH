import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../features/shell/page-placeholder'

export const Route = createFileRoute('/messages')({ component: MessagesPage })

function MessagesPage() {
  return (
    <PagePlaceholder
      actionLabel="返回首页"
      description="消息路由已接通。会话列表、消息流和 WebSocket 实时通道将在实时主链 Issue 实现。"
      title="消息"
    />
  )
}
