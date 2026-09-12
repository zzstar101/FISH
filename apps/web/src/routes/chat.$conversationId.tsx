import { createFileRoute } from '@tanstack/react-router'
import { ChatPage } from '../features/chat/chat-page'

export const Route = createFileRoute('/chat/$conversationId')({
  component: () => {
    const { conversationId } = Route.useParams()
    return <ChatPage conversationId={conversationId} />
  },
})
