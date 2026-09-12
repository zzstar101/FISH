import { createFileRoute } from '@tanstack/react-router'
import { WatchersPage } from '../features/listing-detail/watchers-page'

export const Route = createFileRoute('/watchers/$listingId')({
  component: () => {
    const { listingId } = Route.useParams()
    return <WatchersPage listingId={listingId} />
  },
})
