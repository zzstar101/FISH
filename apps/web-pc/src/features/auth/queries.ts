import type { LoginRequest, RegisterRequest } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isUnauthenticatedError } from '../../lib/api-client'
import { fetchMe, login, logout, register } from './api'

export const authKeys = {
  me: () => ['auth', 'me'] as const,
}

/**
 * 未登录是 `/me` 的正常态（契约：登录态唯一判据就是它 401），
 * 所以在这里收敛成 `null`，而不是让每个调用方去解读 `isError`。
 */
async function loadMe(): Promise<Me | null> {
  try {
    return await fetchMe()
  } catch (error) {
    if (isUnauthenticatedError(error)) return null
    throw error
  }
}

/**
 * `skipAuthRedirect`：`/me` 的 401 正是「未登录」，不该触发全局跳登录
 * （否则任何人打开首页都会被弹到登录页）。见 `lib/query-client.ts`。
 */
export const meQueryOptions = () =>
  queryOptions({
    queryKey: authKeys.me(),
    queryFn: loadMe,
    staleTime: 60_000,
    meta: { skipAuthRedirect: true },
  })

export function useMe() {
  return useQuery(meQueryOptions())
}

export function useLogin() {
  const queryClient = useQueryClient()
  // 登录响应就是 Me，直接写进缓存，省掉一次 /me 往返（契约第 1 节）。
  return useMutation({
    mutationFn: (input: LoginRequest) => login(input),
    onSuccess: (user) => queryClient.setQueryData(authKeys.me(), user),
  })
}

export function useRegister() {
  const queryClient = useQueryClient()
  // 注册即登录，同 useLogin。
  return useMutation({
    mutationFn: (input: RegisterRequest) => register(input),
    onSuccess: (user) => queryClient.setQueryData(authKeys.me(), user),
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.setQueryData(authKeys.me(), null),
  })
}
