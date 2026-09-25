import { Badge } from '@fish/ui/badge'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, Outlet } from '@tanstack/react-router'
import { isUnauthenticatedError } from '../../lib/api-client'
import { isForbiddenAdminError, useAdminMe } from './queries'

/**
 * 管理后台外壳（#73 设计 §7）。
 *
 * - **不进入普通用户的 TabBar**：走独立 /admin 路由分区与独立 AdminShell；
 * - 首次进入调用 `/admin/me`（真实 API 授权边界是服务端 `requireAuth + requireAdmin`，
 *   这里只是体验层）：未登录 → 需要登录；非 Admin → 无权限页，**不展示任何后台数据**；
 * - 导航：概览 / 用户 / 商品 / 审计日志。移动端优先但后台以桌面宽度为主，小屏下导航折成一行。
 */

const NAV_ITEMS = [
  { to: '/admin' as const, label: '概览' },
  { to: '/admin/users' as const, label: '用户' },
  { to: '/admin/listings' as const, label: '商品' },
  { to: '/admin/moderation' as const, label: '审核队列' },
  // 审核记录检索（#73 PR4）：队列只列待审商品，已处理的历史从这里查。
  { to: '/admin/moderation/records' as const, label: '审核记录' },
  // 举报（#73）：与审核队列分开——处理举报不等于处罚用户（grill Q9）。
  { to: '/admin/reports' as const, label: '举报处理' },
  { to: '/admin/transactions' as const, label: '交易查询' },
  { to: '/admin/audit-logs' as const, label: '审计日志' },
]

export function AdminShell() {
  const me = useAdminMe()

  if (me.isPending) return <LoadingState label="正在确认管理权限…" />

  if (me.isError) {
    const error = me.error
    // 未登录：/admin/* 的 401 是「请先登录」，与普通页面共用跳登录语义。
    if (isUnauthenticatedError(error)) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg">
          <EmptyState emoji="🔒" title="需要登录" description="请先登录后再进入管理后台" />
          <Link className="rounded-md bg-brand px-4 py-2 text-sm text-white" to="/login">
            去登录
          </Link>
        </div>
      )
    }
    // 已登录但非 Admin：稳定 403，不泄漏任何后台数据。
    if (isForbiddenAdminError(error)) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg">
          <EmptyState emoji="⛔" title="无管理权限" description="当前账号没有访问管理后台的权限" />
          <Link className="rounded-md border border-line px-4 py-2 text-sm" to="/">
            返回商城
          </Link>
        </div>
      )
    }
    return <ErrorState message="管理后台加载失败" onRetry={() => void me.refetch()} />
  }

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <img alt="鱼小应" className="h-7 w-auto" src="/logo.png" />
            <span className="font-semibold">
              <span className="text-brand">FISH</span> 管理后台
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 text-sm text-ink-2 sm:flex">
              管理员：{me.data?.admin.nickname}
              <Badge shape="pill" variant="secondary">
                {me.data?.admin.role}
              </Badge>
            </span>
            <Link className="text-sm text-ink-3 hover:text-ink" to="/">
              返回商城
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 md:grid-cols-[180px_1fr]">
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="后台导航">
          {NAV_ITEMS.map((item) => (
            <Link
              activeOptions={{ exact: item.to === '/admin' }}
              className="shrink-0 rounded-md px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink [&.active]:bg-brand [&.active]:font-semibold [&.active]:text-white"
              key={item.label}
              to={item.to}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
