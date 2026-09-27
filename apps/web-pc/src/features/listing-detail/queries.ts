import { useQuery } from '@tanstack/react-query'
import { fetchListingDetail } from './api'

export const listingDetailQueryKey = (id: string) => ['pc', 'listings', 'detail', id] as const

export function useListingDetail(id: string) {
  return useQuery({
    queryKey: listingDetailQueryKey(id),
    queryFn: () => fetchListingDetail(id),
    staleTime: 30_000,
  })
}
