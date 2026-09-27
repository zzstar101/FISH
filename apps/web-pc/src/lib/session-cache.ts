import type { Me } from '@fish/contracts/auth/user'
import type { QueryClient } from '@tanstack/react-query'

export const PC_QUERY_PREFIX = 'pc'
export const AUTH_ME_QUERY_KEY = ['auth', 'me'] as const

let sessionGeneration = 0

export function currentSessionGeneration(): number {
  return sessionGeneration
}

/**
 * PC Web 的跨账号隔离边界：先取消可能在飞的旧 `auth/me`，再重置整个 `pc` 命名空间，
 * 最后写入当前会话归属。活跃查询的 observer 会立即丢掉旧结果并重新取服务端数据，
 * 宁可多一次请求也不冒串号风险。
 *
 * 取消期间可能已有更新的登录 / 登出开始，此时本次 reset 已过期，必须返回 `false`
 * 让调用方放弃写入，避免旧会话把新身份覆盖回去。
 *
 * `/me` 自己的 401 处理需要保留当前查询的终止路径，因此可传 `cancelAuth: false`。
 */
export async function resetPcSession(
  queryClient: QueryClient,
  user: Me | null,
  options: { cancelAuth?: boolean } = {},
): Promise<boolean> {
  const generation = sessionGeneration + 1
  sessionGeneration = generation

  if (options.cancelAuth !== false) {
    await queryClient.cancelQueries({ queryKey: AUTH_ME_QUERY_KEY, exact: true })
  }

  if (generation !== sessionGeneration) return false

  const pcQueries = { queryKey: [PC_QUERY_PREFIX] }
  if (user === null) {
    // 登出后 RequireAuth 会卸载业务视图，不要让活跃查询在无 Cookie 时再请求一次。
    queryClient.removeQueries(pcQueries)
  } else {
    // removeQueries 只移出缓存，已挂载的 observer 仍可能显示 A 的结果；resetQueries
    // 会同步通知它清空旧数据并启动新请求。不能等新请求完成才发布 B 的身份。
    void queryClient.resetQueries(pcQueries)
  }
  queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)
  return true
}

/** 只允许启动时所属的会话代际清理；迟到的旧 `/me` 401 不能覆盖新登录用户。 */
export async function resetPcSessionIfCurrent(
  queryClient: QueryClient,
  user: Me | null,
  generation: number,
  options: { cancelAuth?: boolean } = {},
): Promise<boolean> {
  if (generation !== sessionGeneration) return false

  return resetPcSession(queryClient, user, options)
}
