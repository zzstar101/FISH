import type { Me } from '@fish/contracts/auth/user'
import type { QueryClient } from '@tanstack/react-query'
import { syncRecommendationViewer } from '../features/recommendation/queue'

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
 * `cancelQueries` 的 await 是并发重置的交错点：等待期间可能已发生更新的重置（登录、
 * 登出、另一个 401），此时本次重置整体放弃，避免把新身份覆盖回旧值。
 *
 * `/me` 自己的 401 处理需要保留当前查询的终止路径，因此可传 `cancelAuth: false`。
 *
 * @returns 是否由本次调用写入会话归属；`false` 表示已被更新的重置取代，未改动缓存。
 */
export async function resetPcSession(
  queryClient: QueryClient,
  user: Me | null,
  options: { cancelAuth?: boolean } = {},
): Promise<boolean> {
  const generation = ++sessionGeneration

  if (options.cancelAuth !== false) {
    await queryClient.cancelQueries({ queryKey: AUTH_ME_QUERY_KEY, exact: true })
    // 等待期间更新的重置已递增代际并写入新身份：迟到的清理必须整体退出，
    // 否则 removeQueries + setQueryData(null) 会把刚登录的用户登出并丢掉 B 的缓存。
    if (generation !== sessionGeneration) return false
  }

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
  // 登录 / 注册 / 退出 / 401 过期 / `loadMe` 检测到的跨标签页换号都收敛到这里，所以行为事件
  // 队列的身份标记也在这里同步：身份变了就丢掉未发送的旧身份事件（#323 R1 复审 blocker）。
  // 只在本次重置真的写入会话归属后才同步，被更新代际取代的迟到重置（上面已 return false）
  // 不能碰队列，否则会把新身份的事件当成旧身份丢掉。
  syncRecommendationViewer(user?.id ?? null)
  return true
}

/**
 * 只允许启动时所属的会话代际清理；迟到的旧 `/me` 401 不能覆盖新登录用户。
 * 入口代际校验之外，`resetPcSession` 在 `cancelQueries` 的 await 之后还会二次校验，
 * 因此默认（`cancelAuth` 不为 `false`）的调用在等待期间被取代时会返回 `false`。
 */
export async function resetPcSessionIfCurrent(
  queryClient: QueryClient,
  user: Me | null,
  generation: number,
  options: { cancelAuth?: boolean } = {},
): Promise<boolean> {
  if (generation !== sessionGeneration) return false

  return resetPcSession(queryClient, user, options)
}
