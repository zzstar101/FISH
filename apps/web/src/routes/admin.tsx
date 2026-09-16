import { createFileRoute } from '@tanstack/react-router'
import { AdminShell } from '../features/admin/admin-shell'

/**
 * Admin 后台布局路由（#73 设计 §7）：
 * - 与普通用户 TabBar 完全隔离（AdminShell 自带导航，不进入 app-shell/TabBar）；
 * - AdminShell 内做 /admin/me 权限门：未登录 / 非 Admin 只显示对应提示页，不展示后台数据；
 * - 桌面宽度为主（__root 对该前缀放开 430px 限制），小屏导航折成一行。
 */
export const Route = createFileRoute('/admin')({ component: AdminShell })
