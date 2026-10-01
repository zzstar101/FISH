import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { fetchPublicProfile, fetchUserActiveListings } from './api'

export const userProfileKeys = {
  profile: (userId: string) => ['pc', 'users', userId, 'profile'] as const,
  listings: (userId: string) => ['pc', 'users', userId, 'listings'] as const,
}

export function usePublicProfile(userId: string) {
  return useQuery({
    queryKey: userProfileKeys.profile(userId),
    queryFn: () => fetchPublicProfile(userId),
    staleTime: 30_000,
  })
}

/**
 * TA 的在售商品。
 *
 * `enabled` 必须等资料查询成功才为真：契约对不存在的用户返回 404 而不是空列表，
 * 若并发发出，用户会先看到「TA 暂无在售商品」再被 404 覆盖。
 */
export function useUserActiveListings(userId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: userProfileKeys.listings(userId),
    queryFn: ({ pageParam }) => fetchUserActiveListings(userId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  })
}
