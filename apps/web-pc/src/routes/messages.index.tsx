import { createFileRoute } from '@tanstack/react-router'
import { ConversationListPage } from '../features/chat/conversation-list-page'

export const Route = createFileRoute('/messages/')({ component: ConversationListPage })
