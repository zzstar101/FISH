import { createFileRoute } from '@tanstack/react-router'
import { useAuth } from '../features/auth/auth-provider'
import { ConversationPage } from '../features/chat/conversation-page'

export const Route = createFileRoute('/messages/$conversationId')({ component: ConversationRoute })

function ConversationRoute() {
  const { conversationId } = Route.useParams()
  const { me } = useAuth()
  // 账号切换时重挂载会话页：草稿、待发队列与实时连接都绑定旧账号，不能带到新账号。
  return (
    <ConversationPage
      conversationId={conversationId}
      key={`${me?.id ?? 'anonymous'}:${conversationId}`}
    />
  )
}
