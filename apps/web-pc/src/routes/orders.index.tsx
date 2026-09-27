import { createFileRoute } from '@tanstack/react-router'
import { OrdersPage } from '../features/profile/orders-page'

export const Route = createFileRoute('/orders/')({
  component: OrdersRoute,
})

function OrdersRoute() {
  const search = Route.useSearch()
  return <OrdersPage role={search.role} status={search.status} />
}
