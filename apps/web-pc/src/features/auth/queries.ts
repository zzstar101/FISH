import type { Me } from '@fish/contracts/auth/user'
import type { QueryClient } from '@tanstack/react-query'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isUnauthenticatedError } from '../../lib/api-client'
import {
  AUTH_ME_QUERY_KEY,
  currentSessionGeneration,
  resetPcSession,
  resetPcSessionIfCurrent,
} from '../../lib/session-cache'
import { syncRecommendationViewer } from '../recommendation/queue'
import { fetchMe, logout } from './api'

export const authKeys = {
  me: () => AUTH_ME_QUERY_KEY,
}

/**
 * 未登录是 `/me` 的正常态（契约：登录态唯一判据就是它 401），
 * 所以在这里收敛成 `null`，而不是让每个调用方去解读 `isError`。
 */
export async function loadMe(queryClient: QueryClient): Promise<Me | null> {
  const generation = currentSessionGeneration()
  const previous = queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)

  try {
    const user = await fetchMe()
    // 共享同源 Cookie 可能在现有 Web/另一标签页由 A 换成 B，而 PC 没走登录 mutation。
    // 旧代际的迟到响应不能反过来把新身份覆盖回 A。
    if (generation !== currentSessionGeneration()) {
      return queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY) ?? null
    }
    // 冷启动首次建立身份、以及 query 缓存为空时不走 `resetPcSession` 的路径：这里补一次
    // 队列身份同步（身份没变时 `syncRecommendationViewer` 不动队列）。
    syncRecommendationViewer(user.id)
    if (previous === undefined) {
      // 首次建立会话时，公开详情/留言查询可能已经挂载；没有旧身份需要清理。
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)
      return user
    }
    if (previous?.id !== user.id) {
      const reset = await resetPcSessionIfCurrent(queryClient, user, generation, {
        cancelAuth: false,
      })
      if (!reset) return queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY) ?? null
    }
    return user
  } catch (error) {
    if (!isUnauthenticatedError(error)) throw error
    if (generation !== currentSessionGeneration()) return null
    // 401 = 未登录：队列身份落成匿名。旧身份的待发事件在 `syncRecommendationViewer` 里丢弃，
    // 否则它们会被下一次带登录 Cookie 的补发记到别人账号上。
    syncRecommendationViewer(null)
    if (previous === undefined) {
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, null)
      return null
    }
    // 公开详情/留言在匿名态仍挂载；身份未变时不能清掉其查询缓存。
    if (previous === null) return null

    // 当前查询正在执行，不能取消自己；只有同一会话代际的 401 才允许清场。
    await resetPcSessionIfCurrent(queryClient, null, generation, { cancelAuth: false })
    return null
  }
}

/**
 * `skipAuthRedirect`：`/me` 的 401 正是「未登录」，不该触发全局跳登录
 * （否则任何人打开首页都会被弹到登录页）。见 `lib/query-client.ts`。
 */
export const meQueryOptions = (queryClient: QueryClient) =>
  queryOptions({
    queryKey: authKeys.me(),
    queryFn: () => loadMe(queryClient),
    staleTime: 60_000,
    // 共享 Cookie 可在另一标签页换号；即使缓存仍 fresh，回到 PC 也必须重验身份。
    refetchOnWindowFocus: 'always',
    meta: { skipAuthRedirect: true },
  })

export function useMe() {
  const queryClient = useQueryClient()
  return useQuery(meQueryOptions(queryClient))
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => resetPcSession(queryClient, null),
  })
}
