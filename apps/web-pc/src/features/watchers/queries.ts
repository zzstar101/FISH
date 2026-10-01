import { useInfiniteQuery } from '@tanstack/react-query'
import { fetchChatWatchers } from './api'

/**
 * 「谁想要」查询。key 以 `pc` 开头：`resetPcSession` 只按 `['pc']` 前缀清理，
 * 换号时这条查询必须一起被清掉 —— 名单只有卖家本人可读，把 A 的买家名单留给 B
 * 属于越权展示，不只是数据过期。
 */
export const watchersKeys = {
  all: () => ['pc', 'watchers'] as const,
  list: (listingId: string) => ['pc', 'watchers', 'list', listingId] as const,
}

/** cursor 翻页：`nextCursor !== null` 即还有下一页（契约语义），与 wish/listings 同一套写法。 */
export function useChatWatchers(listingId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: watchersKeys.list(listingId),
    queryFn: ({ pageParam }) => fetchChatWatchers(listingId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && listingId !== '',
    // 刻意不设 staleTime：这个弹窗是「现在谁想要我的商品」的**按需查看**，卖家每次打开
    // 都该拿到新鲜名单（买家随时会新发起会话），不像 profile 列表那样背后站着常驻页面。
    // 代价是每次打开一次请求，换来的是「关了再开能看到新买家」。
    staleTime: 0,
  })
}
