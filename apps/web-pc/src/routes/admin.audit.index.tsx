import { createFileRoute } from '@tanstack/react-router'
import { AuditPage } from '../features/admin/audit-page'

export const Route = createFileRoute('/admin/audit/')({
  component: () => {
    const search = Route.useSearch()
    return <AuditPage search={search} />
  },
})
