import { createFileRoute } from '@tanstack/react-router'
import { ChatModerationPage } from '../features/admin/chat-moderation-page'

export const Route = createFileRoute('/admin/chat-moderation')({
  component: () => <ChatModerationPage />,
})
