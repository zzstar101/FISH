import { useQuery } from '@tanstack/react-query'
import { fetchHomeFeed } from './api'

export function useHomeFeed() {
  return useQuery({
    queryKey: ['pc', 'listings', 'home'],
    queryFn: fetchHomeFeed,
    staleTime: 30_000,
  })
}
