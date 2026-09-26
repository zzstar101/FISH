import { createFileRoute } from '@tanstack/react-router'
import { ConversationPage } from '../features/chat/conversation-page'

export const Route = createFileRoute('/messages/$conversationId')({ component: ConversationRoute })

function ConversationRoute() {
  const { conversationId } = Route.useParams()
  return <ConversationPage conversationId={conversationId} />
}
