import { useQuery } from '@tanstack/react-query'
import { fetchListingDetail } from './api'

export function listingDetailQueryKey(id: string, viewerId: string | null = null) {
  return ['pc', 'listings', 'detail', id, viewerId] as const
}

export function useListingDetail(id: string, viewerId: string | null = null) {
  return useQuery({
    queryKey: listingDetailQueryKey(id, viewerId),
    queryFn: () => fetchListingDetail(id),
    staleTime: 30_000,
  })
}
