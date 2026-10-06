import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseDisputesSearch } from '../features/admin/disputes-page'

export const Route = createFileRoute('/admin/disputes')({
  validateSearch: parseDisputesSearch,
  component: () => <Outlet />,
})
