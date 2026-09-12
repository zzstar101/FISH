import { createFileRoute } from '@tanstack/react-router'
import { SearchPage } from '../features/search/search-page'

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>) => ({
    kw: typeof search.kw === 'string' ? search.kw : '',
  }),
  component: () => {
    const { kw } = Route.useSearch()
    return <SearchPage keyword={kw} />
  },
})
