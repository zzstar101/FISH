import { createFileRoute } from '@tanstack/react-router'
import { ModerationDetailPage } from '../features/admin/moderation-detail-page'

export const Route = createFileRoute('/admin/moderation/$recordId')({
  component: () => {
    const { recordId } = Route.useParams()
    return <ModerationDetailPage recordId={recordId} />
  },
})
