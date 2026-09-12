import { useQuery } from '@tanstack/react-query'
import {
  fetchCategoryListings,
  fetchFeed,
  meta,
  type SearchSort,
  searchListings,
} from '../../lib/mock/store'

/**
 * #4 的数据入口。真实 Listing Feed/Search 由 #6 提供，替换点只在这里（#13）。
 * 组件不直接碰 Mock 数据。
 */
export { meta }

export function useFeed() {
  return useQuery({ queryKey: ['feed'], queryFn: fetchFeed, staleTime: 30_000 })
}

export function useCategoryListings(categoryLabel: string | null) {
  return useQuery({
    queryKey: ['category', categoryLabel],
    queryFn: () => fetchCategoryListings(categoryLabel),
    staleTime: 30_000,
  })
}

export function useSearch(keyword: string, sort: SearchSort) {
  return useQuery({
    queryKey: ['search', keyword, sort],
    queryFn: () => searchListings(keyword, sort),
    staleTime: 30_000,
    enabled: keyword.trim().length > 0,
  })
}
