import { createFileRoute, Outlet } from '@tanstack/react-router'

/**
 * 愿望区布局。`/wish`（许愿墙，wish.index.tsx）与 `/wish/$wishId`（愿望详情，#446）
 * 挂在同一个父节点下，父路由只渲染子路由 —— 不写 `<Outlet/>` 子路由就永远不会挂载
 * （orders.tsx / messages.tsx 同款结构）。
 */
export const Route = createFileRoute('/wish')({
  component: WishLayout,
})

function WishLayout() {
  return <Outlet />
}
