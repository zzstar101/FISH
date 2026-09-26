import type { Me } from '@fish/contracts/auth/user'
import type { QueryClient } from '@tanstack/react-query'

export const PC_QUERY_PREFIX = 'pc'
export const AUTH_ME_QUERY_KEY = ['auth', 'me'] as const

let sessionGeneration = 0

export function currentSessionGeneration(): number {
  return sessionGeneration
}

/**
 * PC Web 的跨账号隔离边界：先取消可能在飞的旧 `auth/me`，再清掉整个 `pc` 命名空间，
 * 最后写入当前会话归属。公开列表和详情也在 `pc` 下，清掉后会重新取服务端数据，
 * 宁可多一次请求也不冒串号风险。
 *
 * `/me` 自己的 401 处理需要保留当前查询的终止路径，因此可传 `cancelAuth: false`。
 */
export async function resetPcSession(
  queryClient: QueryClient,
  user: Me | null,
  options: { cancelAuth?: boolean } = {},
): Promise<void> {
  sessionGeneration += 1

  if (options.cancelAuth !== false) {
    await queryClient.cancelQueries({ queryKey: AUTH_ME_QUERY_KEY, exact: true })
  }

  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] === PC_QUERY_PREFIX,
  })
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)
}

/** 只允许启动时所属的会话代际清理；迟到的旧 `/me` 401 不能覆盖新登录用户。 */
export async function resetPcSessionIfCurrent(
  queryClient: QueryClient,
  user: Me | null,
  generation: number,
  options: { cancelAuth?: boolean } = {},
): Promise<boolean> {
  if (generation !== sessionGeneration) return false

  await resetPcSession(queryClient, user, options)
  return true
}
