import type { ListingCategory, ListingSort } from '@fish/contracts/listings/schema'
import { useQuery } from '@tanstack/react-query'
import { meta } from '../../lib/mock/store'
import { fetchCategoryListings, fetchFeed, fetchFreeListings, searchListings } from '../listing/api'

/**
 * #4 的数据入口。Feed / 分类 / 搜索全部走真实 Listing API（#41，#6 契约）。
 * `meta`（分类导航、历史搜索、猜你想找）仍是 fixture：这些是纯前端入口数据，
 * 契约里没有对应端点。
 */
export { meta }

export function useFeed() {
  return useQuery({ queryKey: ['feed'], queryFn: fetchFeed, staleTime: 30_000 })
}

export function useCategoryListings(category: ListingCategory | null) {
  return useQuery({
    queryKey: ['category', category],
    queryFn: () => (category ? fetchCategoryListings(category) : Promise.resolve([])),
    staleTime: 30_000,
    enabled: category !== null,
  })
}

export function useSearch(keyword: string, sort: ListingSort) {
  return useQuery({
    queryKey: ['search', keyword, sort],
    queryFn: () => searchListings(keyword, sort),
    staleTime: 30_000,
    enabled: keyword.trim().length > 0,
  })
}

/** 免费送（priceMaxCents=0）：首页快捷入口，不依赖关键词。 */
export function useFreeListings(sort: ListingSort) {
  return useQuery({
    queryKey: ['search', 'free', sort],
    queryFn: () => fetchFreeListings(sort),
    staleTime: 30_000,
  })
}
