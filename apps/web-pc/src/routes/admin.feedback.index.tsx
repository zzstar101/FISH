import { createFileRoute } from '@tanstack/react-router'
import { FeedbackQueuePage } from '../features/admin/feedback-page'

export const Route = createFileRoute('/admin/feedback/')({
  component: () => {
    const search = Route.useSearch()
    return <FeedbackQueuePage search={search} />
  },
})
