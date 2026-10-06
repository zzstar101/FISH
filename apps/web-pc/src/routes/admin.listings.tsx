import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseListingsSearch } from '../features/admin/listings-page'

export const Route = createFileRoute('/admin/listings')({
  validateSearch: parseListingsSearch,
  component: () => <Outlet />,
})
