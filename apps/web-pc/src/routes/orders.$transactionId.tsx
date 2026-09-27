import { createFileRoute } from '@tanstack/react-router'
import { OrderDetailPage } from '../features/profile/order-detail-page'

export const Route = createFileRoute('/orders/$transactionId')({
  component: OrderDetailRoute,
})

function OrderDetailRoute() {
  const { transactionId } = Route.useParams()
  return <OrderDetailPage transactionId={transactionId} />
}
