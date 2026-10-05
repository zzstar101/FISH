import { createFileRoute } from '@tanstack/react-router'
import { ListingDetailPage } from '../features/admin/listing-detail-page'

export const Route = createFileRoute('/admin/listings/$listingId')({
  component: () => {
    const { listingId } = Route.useParams()
    return <ListingDetailPage listingId={listingId} />
  },
})
