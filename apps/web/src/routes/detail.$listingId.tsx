import { createFileRoute } from '@tanstack/react-router'
import { DetailPage } from '../features/listing-detail/detail-page'

export const Route = createFileRoute('/detail/$listingId')({
  component: () => {
    const { listingId } = Route.useParams()
    return <DetailPage listingId={listingId} />
  },
})
