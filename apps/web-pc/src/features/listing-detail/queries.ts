import { useQuery } from '@tanstack/react-query'
import { fetchListingDetail } from './api'

export const listingDetailQueryKey = (id: string) => ['pc', 'listings', 'detail', id] as const

export function useListingDetail(id: string, enabled = true) {
  return useQuery({
    queryKey: listingDetailQueryKey(id),
    queryFn: () => fetchListingDetail(id),
    enabled: enabled && id !== '',
    staleTime: 30_000,
  })
}
