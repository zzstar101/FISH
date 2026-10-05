import { createFileRoute } from '@tanstack/react-router'
import { DisputesPage } from '../features/admin/disputes-page'

export const Route = createFileRoute('/admin/disputes/')({
  component: () => {
    const search = Route.useSearch()
    return <DisputesPage search={search} />
  },
})
