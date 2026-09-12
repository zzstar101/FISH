import { createFileRoute } from '@tanstack/react-router'
import { MessagePage } from '../features/chat/message-page'

export const Route = createFileRoute('/message')({ component: MessagePage })
