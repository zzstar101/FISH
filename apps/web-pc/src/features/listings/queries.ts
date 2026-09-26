import type { ListingCategory, ListingSort } from '@fish/contracts/listings/schema'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { fetchHomeFeed, fetchListingFeed } from './api'

export type ListingSearchFilters = {
  q?: string
  category?: ListingCategory
  sort: ListingSort
}

export function useHomeFeed() {
  return useQuery({
    queryKey: ['pc', 'listings', 'home'],
    queryFn: fetchHomeFeed,
    staleTime: 30_000,
  })
}

export function useListingSearch(filters: ListingSearchFilters) {
  return useInfiniteQuery({
    queryKey: ['pc', 'listings', 'search', filters],
    queryFn: ({ pageParam }) =>
      fetchListingFeed({ ...filters, limit: 24, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  })
}
