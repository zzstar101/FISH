import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseReportsSearch } from '../features/admin/reports-page'

export const Route = createFileRoute('/admin/reports')({
  validateSearch: parseReportsSearch,
  component: () => <Outlet />,
})
