import { createFileRoute, Outlet } from '@tanstack/react-router'

/**
 * 管理后台布局路由（#467）。壳由 `__root.tsx` 的 RootChrome 对 `/admin` 分支渲染
 * （AdminShell + RequireAuth），本路由只提供 `/admin` 路径节点与嵌套出口。
 */
export const Route = createFileRoute('/admin')({
  component: () => <Outlet />,
})
