import { createFileRoute } from '@tanstack/react-router'
import { ReviewModerationPage } from '../features/admin/review-moderation-page'

export const Route = createFileRoute('/admin/reviews-moderation')({
  component: () => <ReviewModerationPage />,
})
