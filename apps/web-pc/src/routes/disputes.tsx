import { createFileRoute, Outlet } from '@tanstack/react-router'

/**
 * 争议区布局：`/disputes` 列表与 `/disputes/$disputeId` 详情挂在同一个父节点下，
 * 父路由只渲染子路由，不持有页面状态。
 */
export const Route = createFileRoute('/disputes')({
  component: DisputesLayout,
})

function DisputesLayout() {
  return <Outlet />
}
