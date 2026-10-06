import { createFileRoute } from '@tanstack/react-router'
import { ReportsPage } from '../features/admin/reports-page'

export const Route = createFileRoute('/admin/reports/')({
  component: () => {
    const search = Route.useSearch()
    return <ReportsPage search={search} />
  },
})
