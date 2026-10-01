import type { ListingCategory, ListingSort } from '@fish/contracts/listings/schema'
import { useInfiniteQuery } from '@tanstack/react-query'
import { fetchRecommendationFeed } from '../recommendation/api'
import { fetchListingFeed } from './api'

export type ListingSearchFilters = {
  q?: string
  category?: ListingCategory
  sort: ListingSort
}

/**
 * 首页 feed 走推荐端点（#323 R1）：R1 服务端透传 `newest`，顺序与 `GET /listings` 一致，
 * 但它额外给出 `requestId`——曝光和详情归因必须挂到真实的推荐请求上才成立。
 * 分页沿用搜索页同一套写法，翻页时服务端复用同一个 requestId，position 才能连续。
 */
export function useHomeFeed() {
  return useInfiniteQuery({
    queryKey: ['pc', 'listings', 'home'],
    queryFn: ({ pageParam }) =>
      fetchRecommendationFeed({ limit: 24, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  })
}

export function useListingSearch(
  filters: ListingSearchFilters,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: ['pc', 'listings', 'search', filters],
    queryFn: ({ pageParam }) =>
      fetchListingFeed({ ...filters, limit: 24, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    // 编号精确查询（#382）期间必须关掉关键词请求：输入是编号时不把编号当关键词模糊搜。
    // enabled 不进 queryKey——它只控制发不发请求，关键词/筛选不变时缓存仍是同一条。
    enabled: options.enabled ?? true,
  })
}
