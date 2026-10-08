import { createFileRoute } from '@tanstack/react-router'
import { FeedbackPage } from '../features/feedback/feedback-page'

export const Route = createFileRoute('/feedback')({ component: FeedbackPage })
