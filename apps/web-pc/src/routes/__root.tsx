import { createRootRoute, Outlet, useLocation, useMatchRoute } from '@tanstack/react-router'
import { AuthProvider } from '../features/auth/auth-provider'
import { RequireAuth } from '../features/auth/require-auth'
import { PcShell } from '../features/shell/pc-shell'

export const Route = createRootRoute({ component: RootLayout })

function RootLayout() {
  return (
    <AuthProvider>
      <RootChrome />
    </AuthProvider>
  )
}

/**
 * 登录 / 注册走独立页面；商品详情是公开只读页（T5 的匿名留言读取依赖它）。
 * 其余 PC Web 路由统一进入登录守卫和 PC 外壳。
 * `useLocation()` 返回的是去掉 basepath 的内部路径；这里去掉尾斜杠后再比较。
 */
function RootChrome() {
  const { pathname: rawPathname } = useLocation()
  const matchRoute = useMatchRoute()
  const pathname = rawPathname.replace(/\/+$/, '') || '/'
  const isAuthPage = pathname === '/login' || pathname === '/register'
  const isPublicListing = Boolean(matchRoute({ to: '/listing/$listingId' }))

  if (isAuthPage) return <Outlet />
  if (isPublicListing) return <PcShell />

  return (
    <RequireAuth>
      <PcShell />
    </RequireAuth>
  )
}
