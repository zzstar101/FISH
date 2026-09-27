import {
  createRootRoute,
  Outlet,
  useLocation,
  useMatchRoute,
  useRouterState,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
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
 * 登录 / 注册走独立页面；商品详情是公开只读页（T5 的匿名留言读取依赖它）。
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
  const isAuthPage = pathname === '/login' || pathname === '/register'
  const isPublicListing = Boolean(matchRoute({ to: '/listing/$listingId' }))

  if (isNotFound) {
    return (
      <PcShell>
        <RouteNotFoundPage />
      </PcShell>
    )
  }
  if (isAuthPage) return <Outlet />
  if (isPublicListing) return <PcShell />

  return (
    <RequireAuth>
      <PcShell />
    </RequireAuth>
  )
}
