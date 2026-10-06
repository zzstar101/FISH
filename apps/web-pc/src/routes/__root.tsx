import {
  createRootRoute,
  Outlet,
  useLocation,
  useMatchRoute,
  useRouterState,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AdminShell } from '../features/admin/admin-shell'
import { AuthProvider } from '../features/auth/auth-provider'
import { RequireAuth } from '../features/auth/require-auth'
import { PcShell } from '../features/shell/pc-shell'
import { RouteErrorPage, RouteNotFoundPage } from '../features/shell/route-fallback'

export const Route = createRootRoute({
  shellComponent: AuthShell,
  component: RootLayout,
  errorComponent: RouteErrorPage,
  notFoundComponent: RouteNotFoundPage,
})

/** Router 级 provider 外壳：错误边界和 404 页也必须能读取登录态。 */
function AuthShell({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

function RootLayout() {
  return <RootChrome />
}

/**
 * 登录走独立页面（注册已下线，#391）；商品详情与**他人主页**是公开只读页
 * （T5 的匿名留言读取依赖前者；`USER_ROUTES` 两个端点都不挂 `requireAuth`，
 * 契约明确要求他人主页对未登录访客可读，依赖后者）。
 * 未匹配路径先渲染 PC 404，避免被登录守卫截走；其余路由统一进入登录守卫和 PC 外壳。
 * `useLocation()` 返回的是去掉 basepath 的内部路径；这里去掉尾斜杠后再比较。
 */
function RootChrome() {
  const { pathname: rawPathname } = useLocation()
  const matchRoute = useMatchRoute()
  const isNotFound = useRouterState({
    select: (state) => state.matches.some((match) => match._notFound),
  })
  const pathname = rawPathname.replace(/\/+$/, '') || '/'
  const isAuthPage = pathname === '/login'
  const isPublicListing = Boolean(matchRoute({ to: '/listing/$listingId' }))
  const isPublicProfile = Boolean(matchRoute({ to: '/users/$userId' }))
  /**
   * 管理后台走独立壳（#467）：与用户侧交易页面区分，同样受登录守卫；管理员身份由
   * AdminShell 内的 `/admin/me` 校验（服务端 ADMIN 守卫仍是权限真源）。
   */
  const isAdminArea = pathname === '/admin' || pathname.startsWith('/admin/')

  if (isNotFound) {
    return (
      <PcShell>
        <RouteNotFoundPage />
      </PcShell>
    )
  }
  if (isAuthPage) return <Outlet />
  if (isPublicListing || isPublicProfile) return <PcShell />
  if (isAdminArea) {
    return (
      <RequireAuth>
        <AdminShell />
      </RequireAuth>
    )
  }

  return (
    <RequireAuth>
      <PcShell />
    </RequireAuth>
  )
}
