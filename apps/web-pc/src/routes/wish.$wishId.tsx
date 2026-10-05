import { createFileRoute } from '@tanstack/react-router'
import { WishDetailPage } from '../features/wish/wish-detail-page'

export const Route = createFileRoute('/wish/$wishId')({
  component: WishDetailRoute,
})

function WishDetailRoute() {
  const { wishId } = Route.useParams()
  return <WishDetailPage key={wishId} wishId={wishId} />
}
