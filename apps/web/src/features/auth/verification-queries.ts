import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authKeys } from './queries'
import {
  fetchVerificationStatus,
  sendVerificationCode,
  verifyCampusEmail,
} from './verification-api'

/**
 * 校园认证（#68）数据入口。验证成功会改变 `Me.authStatus`，
 * 因此 `onSuccess` 同时失效 `auth.me`，Profile 顶部的徽章立刻翻转为已认证。
 */
export function useVerificationStatus() {
  return useQuery({
    queryKey: ['auth', 'verification'],
    queryFn: fetchVerificationStatus,
  })
}

export function useSendVerificationCode() {
  return useMutation({ mutationFn: sendVerificationCode })
}

export function useVerifyCampusEmail() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: verifyCampusEmail,
    onSuccess: (status) => {
      queryClient.setQueryData(['auth', 'verification'], status)
      // 认证状态在 Profile 与公开卖家信息中保持一致（Done）：Me 失效后 /me 重新拉取。
      void queryClient.invalidateQueries({ queryKey: authKeys.me() })
      void queryClient.invalidateQueries({ queryKey: ['listing'] })
    },
  })
}
