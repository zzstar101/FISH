import type { MyCommentsKind } from '@fish/contracts/comments/schema'
import { useInfiniteQuery } from '@tanstack/react-query'
import { fetchMyComments } from './api'

/**
 * 缓存键带 `ownerId`（与 view-history 同一口径）：换账号时即使漏了全局 reset，
 * 不同 owner 的键也不相等。`resetPcSession` 的 `['pc']` 全量清理仍是第一道防线。
 */
export const myCommentsKeys = {
  all: () => ['pc', 'my-comments'] as const,
  list: (ownerId: string, kind: MyCommentsKind) =>
    [...myCommentsKeys.all(), 'list', ownerId, kind] as const,
}

/**
 * 单一分段（kind）的列表：游标分页，`nextCursor !== null` 即还有下一页。
 * `total` 随每页回传且与该分段同口径——分段胶囊计数直接取第一页的 `total`，
 * 与渲染中的列表同一次请求，不旁路再发 count。
 * `staleTime: 0`——进页就要看到最新状态（刚删过的留言不应再出现）。
 */
export function useMyComments(ownerId: string, kind: MyCommentsKind) {
  return useInfiniteQuery({
    queryKey: myCommentsKeys.list(ownerId, kind),
    queryFn: ({ pageParam }) =>
      fetchMyComments({ limit: 20, kind, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== '',
    staleTime: 0,
  })
}
