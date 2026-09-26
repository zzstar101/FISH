import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
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
 * 登录 / 注册走独立页面，其余 PC Web 路由统一进入登录守卫和 PC 外壳。
 * `useLocation()` 返回的是去掉 basepath 的内部路径；这里去掉尾斜杠后再比较。
 */
function RootChrome() {
  const { pathname: rawPathname } = useLocation()
  const pathname = rawPathname.replace(/\/+$/, '') || '/'
  const isAuthPage = pathname === '/login' || pathname === '/register'

  if (isAuthPage) return <Outlet />

  return (
    <RequireAuth>
      <PcShell />
    </RequireAuth>
  )
}
