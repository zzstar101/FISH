import { ErrorState, LoadingState } from '@fish/ui/states'
import { Navigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { currentHref } from '../../lib/redirect'
import { useAuth } from './auth-provider'

/** 登录守卫：初始化完成前不判断；未登录回登录页并带当前 PC Web 路径。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, isInitializing, error, refetch } = useAuth()

  if (isInitializing) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <LoadingState label="正在恢复登录状态…" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <ErrorState message="登录状态加载失败" onRetry={refetch} />
      </div>
    )
  }

  if (!me) {
    return <Navigate replace search={{ redirect: currentHref() }} to="/login" />
  }

  return <>{children}</>
}
