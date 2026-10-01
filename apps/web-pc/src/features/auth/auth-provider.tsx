import type { Me } from '@fish/contracts/auth/user'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useMe } from './queries'

type AuthState = {
  /** `null` = 未登录。契约里 401 是正常态，不是错误态。 */
  me: Me | null
  /**
   * 只有首次还没有任何 `/me` 结果时才为 true。
   *
   * 回到标签页触发的后台重验即使还在 `isFetching`，也不能算「初始化」——否则
   * RequireAuth 会卸载整个业务视图，发布草稿 / 滚动位置 / 弹窗状态都会在每次窗口
   * 焦点变化时丢失。跨标签页换号由 `loadMe` → `resetPcSession` 清空 `pc` 缓存处理。
   */
  isInitializing: boolean
  /** `/me` 的非 401 错误（网络、500、契约漂移）；不能当成未登录吞掉。 */
  error: unknown
  refetch: () => void
}

const AuthContext = createContext<AuthState | null>(null)

/** 登录态初始化：应用挂载时获取 `GET /me`，窗口重新获得焦点时再校验一次，结果通过 context 供全站读取。 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = useMe()
  const value = useMemo<AuthState>(
    () => ({
      me: data ?? null,
      isInitializing: data === undefined && isPending,
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
