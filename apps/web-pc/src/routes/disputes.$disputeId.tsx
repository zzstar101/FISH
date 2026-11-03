import { createFileRoute } from '@tanstack/react-router'
import { DisputeDetailPage } from '../features/disputes/dispute-detail-page'

export const Route = createFileRoute('/disputes/$disputeId')({
  component: DisputeDetailRoute,
})

function DisputeDetailRoute() {
  const { disputeId } = Route.useParams()
  return <DisputeDetailPage disputeId={disputeId} />
}
