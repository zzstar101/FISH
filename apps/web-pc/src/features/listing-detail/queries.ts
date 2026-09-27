import { useQuery } from '@tanstack/react-query'
import { fetchListingDetail } from './api'

export function useListingDetail(id: string) {
  return useQuery({
    queryKey: ['pc', 'listings', 'detail', id],
    queryFn: () => fetchListingDetail(id),
    staleTime: 30_000,
  })
}
