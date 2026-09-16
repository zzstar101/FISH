import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
import { AuthBackground } from '../features/auth/auth-background'
import { AuthProvider, useAuth } from '../features/auth/auth-provider'
import { useRealtime } from '../features/chat/realtime'

/**
 * 应用外壳：AuthProvider + 移动端视口容器。
 * 桌面端只做兼容，内容固定居中在 430px 以内（architecture.md §1）。
 */
export const Route = createRootRoute({ component: RootLayout })

/** 需要波浪背景的路由。 */
const AUTH_PATHS = new Set(['/login', '/register'])

/** 管理后台（#73）：放宽 430px 移动端视口限制，后台以桌面宽度为主（设计 §7）。 */
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

/** 登录后维持 `/ws/chat` 实时连接；登出（或未登录）时断开。 */
function RealtimeGate() {
  const { me } = useAuth()
  useRealtime(me !== null)
  return null
}

function RootLayout() {
  const { pathname } = useLocation()

  return (
    <AuthProvider>
      <RealtimeGate />
      {/*
        背景挂在根布局而不是页面组件里：登录 / 注册是两个路由，互切时页面会重挂载；
        背景若跟着重建，WebGL 上下文要重编译、波浪相位归零，肉眼就是跳一下。
        放在这一层，只有离开认证页时才会卸载。
      */}
      <div
        className={`relative isolate mx-auto min-h-dvh w-full bg-bg ${
          isAdminPath(pathname) ? 'max-w-6xl' : 'max-w-[430px]'
        }`}
      >
        {AUTH_PATHS.has(pathname) && <AuthBackground />}
        <Outlet />
      </div>
    </AuthProvider>
  )
}
