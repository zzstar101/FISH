import { createFileRoute } from '@tanstack/react-router'
import { DisputeDetailPage } from '../features/admin/dispute-detail-page'

export const Route = createFileRoute('/admin/disputes/$disputeId')({
  component: () => {
    const { disputeId } = Route.useParams()
    const search = Route.useSearch()
    return <DisputeDetailPage disputeId={disputeId} search={search} />
  },
})
