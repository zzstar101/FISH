import { createFileRoute } from '@tanstack/react-router'
import { OrdersPage } from '../features/profile/orders-page'

export const Route = createFileRoute('/orders')({ component: OrdersPage })
