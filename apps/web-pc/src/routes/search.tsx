import { createFileRoute } from '@tanstack/react-router'
import { SearchPage } from '../features/search/search-page'
import { parseSearchParams } from '../features/search/search-params'

export const Route = createFileRoute('/search')({
  validateSearch: parseSearchParams,
  component: SearchRoute,
})

function SearchRoute() {
  const search = Route.useSearch()
  return <SearchPage {...search} />
}
