import { useQuery } from '@tanstack/react-query'
import { fetchMatches } from '../../lib/mock/store'

/**
 * #8 的数据入口。Match 契约尚未冻结（`packages/contracts/src/matching/**`），
 * 这里先用 Mock 形状，等 #8 后端冻结后再对齐字段。
 */
export function useMatches(listingId: string) {
  return useQuery({
    queryKey: ['match', listingId],
    queryFn: () => fetchMatches(listingId),
    enabled: listingId.length > 0,
  })
}
