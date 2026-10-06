import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseAuditSearch } from '../features/admin/audit-page'

export const Route = createFileRoute('/admin/audit')({
  validateSearch: parseAuditSearch,
  component: () => <Outlet />,
})
