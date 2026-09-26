import type { LoginRequest, RegisterRequest } from '@fish/contracts/auth/session'
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
import { fetchMe, login, logout, register } from './api'

export const authKeys = {
  me: () => AUTH_ME_QUERY_KEY,
}

/**
 * 未登录是 `/me` 的正常态（契约：登录态唯一判据就是它 401），
 * 所以在这里收敛成 `null`，而不是让每个调用方去解读 `isError`。
 */
export async function loadMe(queryClient: QueryClient): Promise<Me | null> {
  const generation = currentSessionGeneration()

  try {
    const user = await fetchMe()
    // 共享同源 Cookie 可能在现有 Web/另一标签页由 A 换成 B，而 PC 没走登录 mutation。
    // 旧代际的迟到响应不能反过来把新身份覆盖回 A。
    if (generation !== currentSessionGeneration()) {
      return queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY) ?? null
    }
    const previous = queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)
    if (previous?.id !== user.id) {
      const reset = await resetPcSessionIfCurrent(queryClient, user, generation, {
        cancelAuth: false,
      })
      if (!reset) return queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY) ?? null
    }
    return user
  } catch (error) {
    if (!isUnauthenticatedError(error)) throw error

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
    meta: { skipAuthRedirect: true },
  })

export function useMe() {
  const queryClient = useQueryClient()
  return useQuery(meQueryOptions(queryClient))
}

export function useLogin() {
  const queryClient = useQueryClient()
  // 登录响应就是 Me，直接写进缓存；先清旧账号命名空间再落新用户（T3）。
  return useMutation({
    mutationFn: (input: LoginRequest) => login(input),
    onSuccess: (user) => resetPcSession(queryClient, user),
  })
}

export function useRegister() {
  const queryClient = useQueryClient()
  // 注册即登录，同 useLogin。
  return useMutation({
    mutationFn: (input: RegisterRequest) => register(input),
    onSuccess: (user) => resetPcSession(queryClient, user),
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => resetPcSession(queryClient, null),
  })
}
