import { createFileRoute } from '@tanstack/react-router'
import { MetricsPage, parseMetricsSearch } from '../features/admin/metrics-page'

export const Route = createFileRoute('/admin/metrics')({
  validateSearch: parseMetricsSearch,
  component: () => {
    const search = Route.useSearch()
    return <MetricsPage search={search} />
  },
})
