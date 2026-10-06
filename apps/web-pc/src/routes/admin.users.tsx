import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseUsersSearch } from '../features/admin/users-page'

export const Route = createFileRoute('/admin/users')({
  validateSearch: parseUsersSearch,
  component: () => <Outlet />,
})
