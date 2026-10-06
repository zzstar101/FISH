import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseTransactionsSearch } from '../features/admin/transactions-page'

export const Route = createFileRoute('/admin/transactions')({
  validateSearch: parseTransactionsSearch,
  component: () => <Outlet />,
})
