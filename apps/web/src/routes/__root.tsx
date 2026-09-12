import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
import { AuthBackground } from '../features/auth/auth-background'
import { AuthProvider } from '../features/auth/auth-provider'

/**
 * 应用外壳：AuthProvider + 移动端视口容器。
 * 桌面端只做兼容，内容固定居中在 430px 以内（architecture.md §1）。
 */
export const Route = createRootRoute({ component: RootLayout })

/** 需要波浪背景的路由。 */
const AUTH_PATHS = new Set(['/login', '/register'])

function RootLayout() {
  const { pathname } = useLocation()

  return (
    <AuthProvider>
      {/*
        背景挂在根布局而不是页面组件里：登录 / 注册是两个路由，互切时页面会重挂载；
        背景若跟着重建，WebGL 上下文要重编译、波浪相位归零，肉眼就是跳一下。
        放在这一层，只有离开认证页时才会卸载。
      */}
      <div className="relative isolate mx-auto min-h-dvh w-full max-w-[430px] bg-bg">
        {AUTH_PATHS.has(pathname) && <AuthBackground />}
        <Outlet />
      </div>
    </AuthProvider>
  )
}
