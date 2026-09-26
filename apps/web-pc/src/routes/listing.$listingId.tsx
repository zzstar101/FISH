import { createFileRoute } from '@tanstack/react-router'
import { ListingDetailPage } from '../features/listing-detail/detail-page'

export const Route = createFileRoute('/listing/$listingId')({
  component: ListingDetailRoute,
})

function ListingDetailRoute() {
  const { listingId } = Route.useParams()
  return <ListingDetailPage listingId={listingId} />
}
