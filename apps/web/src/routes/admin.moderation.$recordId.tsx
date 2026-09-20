import { createFileRoute } from '@tanstack/react-router'
import { ModerationDecisionForm } from '../features/admin/moderation-queue-page'

export const Route = createFileRoute('/admin/moderation/$recordId')({
  component: () => <ModerationDecisionForm recordId={Route.useParams().recordId} />,
})
