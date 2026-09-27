import { useQuery } from '@tanstack/react-query'
import { fetchListingDetail } from './api'

/**
 * 详情缓存按「商品 + 当前查看者」隔离：同一商品在匿名与不同账号下可能看到
 * 不同的 owner/互动状态，缓存 key 必须带上 viewer，避免切号后读到上一账号的视图。
 */
export function listingDetailQueryKey(id: string, viewerId: string | null = null) {
  return ['pc', 'listings', 'detail', id, viewerId] as const
}

export function useListingDetail(
  id: string,
  viewerId: string | null = null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: listingDetailQueryKey(id, viewerId),
    queryFn: () => fetchListingDetail(id),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  })
}
