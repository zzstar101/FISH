import { createFileRoute } from '@tanstack/react-router'
import { MatchPage } from '../features/match/match-page'

export const Route = createFileRoute('/match')({
  validateSearch: (search: Record<string, unknown>) => ({
    goods: typeof search.goods === 'string' ? search.goods : 'p9',
  }),
  component: () => {
    const { goods } = Route.useSearch()
    return <MatchPage listingId={goods} />
  },
})
