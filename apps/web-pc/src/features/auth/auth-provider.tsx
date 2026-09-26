import type { Me } from '@fish/contracts/auth/user'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useMe } from './queries'

type AuthState = {
  /** `null` = 未登录。契约里 401 是正常态，不是错误态。 */
  me: Me | null
  /** 首次 `GET /me` 尚未返回。此时 `me === null` 还不能断言「未登录」。 */
  isInitializing: boolean
  /** `/me` 的非 401 错误（网络、500、契约漂移）；不能当成未登录吞掉。 */
  error: unknown
  refetch: () => void
}

const AuthContext = createContext<AuthState | null>(null)

/** 登录态初始化：应用挂载时打一次 `GET /me`，结果通过 context 供全站读取。 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = useMe()
  const value = useMemo<AuthState>(
    () => ({
      me: data ?? null,
      isInitializing: isPending,
      error,
      refetch: () => void refetch(),
    }),
    [data, isPending, error, refetch],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth 必须在 <AuthProvider> 内使用')
  return value
}
