import { createFileRoute } from '@tanstack/react-router'
import { ModerationQueuePage } from '../features/admin/moderation-queue-page'

export const Route = createFileRoute('/admin/moderation/')({ component: ModerationQueuePage })
