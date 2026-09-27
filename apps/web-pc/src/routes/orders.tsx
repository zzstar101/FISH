import { transactionRoleSchema, transactionStatusSchema } from '@fish/contracts/transactions/schema'
import { createFileRoute, Outlet } from '@tanstack/react-router'

export type OrdersSearch = {
  role: 'buyer' | 'seller'
  status?: 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'
}

/**
 * 订单区布局。
 *
 * `/orders` 的列表与 `/orders/$transactionId` 详情都挂在同一个父节点下，
 * 父路由只渲染子路由，不持有页面状态。
 */
export const Route = createFileRoute('/orders')({
  validateSearch: (search: Record<string, unknown>): OrdersSearch => {
    const role = transactionRoleSchema.safeParse(search.role)
    const status = transactionStatusSchema.safeParse(search.status)
    return {
      role: role.success ? role.data : 'buyer',
      ...(status.success ? { status: status.data } : {}),
    }
  },
  component: OrdersLayout,
})

function OrdersLayout() {
  return <Outlet />
}
