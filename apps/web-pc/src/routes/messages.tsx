import { createFileRoute, Outlet } from '@tanstack/react-router'

/**
 * 消息区布局。
 *
 * `/messages` 的列表与 `/messages/$conversationId` 详情都挂在同一个路由父节点下，
 * 因此父路由只负责渲染子路由，不持有页面状态或 WebSocket 连接。
 */
export const Route = createFileRoute('/messages')({ component: MessagesLayout })

function MessagesLayout() {
  return <Outlet />
}
