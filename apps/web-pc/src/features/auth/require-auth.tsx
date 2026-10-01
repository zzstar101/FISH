import { ErrorState, LoadingState } from '@fish/ui/states'
import { Navigate } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'
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

  // 已有可用身份时的后台重验失败不卸载页面；错误只在还没有身份结果时升级为错误页。
  if (error && me === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <ErrorState message="登录状态加载失败" onRetry={refetch} />
      </div>
    )
  }

  if (!me) {
    return <Navigate replace search={{ redirect: currentHref() }} to="/login" />
  }

  // 身份真的变了才重挂载业务视图：同账号的后台重验保留页面状态，换号则清掉旧账号状态。
  return <Fragment key={me.id}>{children}</Fragment>
}
