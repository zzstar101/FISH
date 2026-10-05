import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { LiquidGlassLayer } from '@fish/ui/liquid-glass'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, Outlet } from '@tanstack/react-router'
import {
  ArrowLeftRight,
  Flag,
  Gauge,
  LayoutDashboard,
  Package,
  ScrollText,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { adminLoadOutcome } from './admin-messages'
import { useAdminMe } from './admin-queries'
import { ADMIN_CAPABILITY_LABEL, roleMeta } from './admin-view'

const ADMIN_NAV_ITEMS = [
  { to: '/admin', label: '概览', Icon: LayoutDashboard, exact: true },
  { to: '/admin/users', label: '用户', Icon: Users, exact: false },
  { to: '/admin/listings', label: '商品', Icon: Package, exact: false },
  { to: '/admin/moderation', label: '审核', Icon: ShieldCheck, exact: false },
  { to: '/admin/reports', label: '举报', Icon: Flag, exact: false },
  { to: '/admin/transactions', label: '交易', Icon: ArrowLeftRight, exact: false },
  { to: '/admin/audit', label: '审计', Icon: ScrollText, exact: false },
  { to: '/admin/metrics', label: '推荐指标', Icon: Gauge, exact: false },
] as const

/**
 * 管理后台独立布局（#467 验收 1）：与用户侧 PcShell 分开，路由收敛在 `/admin/*`，
 * 共用同一个会话（服务端 ADMIN 守卫仍是权限真源——这里只决定「画什么」，不决定「给什么」）。
 * 由 `__root.tsx` 的 RootChrome 分支渲染：RequireAuth 先保证已登录，本壳再经 `/admin/me`
 * 校验管理员身份，普通用户落在无权限页而非后台骨架。
 */
export function AdminShell() {
  const me = useAdminMe(true)

  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <LoadingState label="正在校验管理身份…" />
      </div>
    )
  }
  if (me.isError) {
    const outcome = adminLoadOutcome(me.error)
    // 403 FORBIDDEN 是普通用户的**预期终态**：整页权限态，不给「重试」假动作。
    if (outcome.kind === 'forbidden') {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-bg">
          <EmptyState
            action={
              <Button asChild variant="outline">
                <Link to="/">返回前台</Link>
              </Button>
            }
            description="当前账号不是管理员。如有需要，请联系平台负责人开通。"
            emoji="🚫"
            title="无管理权限"
          />
        </div>
      )
    }
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <ErrorState
          message={outcome.kind === 'error' ? outcome.message : '管理身份校验失败'}
          onRetry={() => void me.refetch()}
        />
      </div>
    )
  }
  if (me.data === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <LoadingState label="正在校验管理身份…" />
      </div>
    )
  }

  const { admin, capabilities } = me.data
  const roleView = roleMeta(admin.role)

  return (
    <div className="min-h-dvh">
      <header className="pc-glass sticky top-0 z-30 h-16 border-b border-white/55 bg-white/85">
        <LiquidGlassLayer saturation={120} />
        <div className="mx-auto flex h-full max-w-[1600px] items-center gap-4 px-8">
          <Link className="flex min-w-[200px] items-center gap-2.5" to="/admin">
            <img alt="鱼小应" className="size-8 object-contain" src="/pc/brand-fish.png" />
            <span className="font-bold text-[17px] tracking-[-0.02em]">鱼小应</span>
            <Badge variant="brand">管理后台</Badge>
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <Link
              className="rounded-lg px-3 py-2 text-ink-2 text-sm transition-colors hover:bg-surface-2 hover:text-ink"
              to="/"
            >
              ← 返回前台
            </Link>
            <span className="font-medium text-sm">{admin.nickname}</span>
            <Badge variant={roleView.variant}>{roleView.label}</Badge>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] grid-cols-[200px_minmax(0,1fr)] gap-6 px-8 py-8">
        <aside className="sticky top-24 self-start">
          <div className="pc-glass relative z-0 rounded-2xl border border-white/55 bg-white/60 p-2.5">
            <LiquidGlassLayer blurAmount={0.08} displacementScale={22} />
            <nav aria-label="管理导航" className="flex flex-col gap-1">
              {ADMIN_NAV_ITEMS.map(({ to, label, Icon, exact }) => (
                <Link
                  activeOptions={{ exact }}
                  className="flex h-10 items-center gap-2.5 rounded-xl px-3 text-ink-2 text-sm transition-colors hover:bg-white/55 hover:text-ink [&.active]:bg-white/80 [&.active]:font-semibold [&.active]:text-lavender"
                  key={label}
                  to={to}
                >
                  <Icon className="size-4.5" />
                  {label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="mt-5 rounded-2xl border border-white/70 bg-white/72 p-4 backdrop-blur-md">
            <p className="text-ink-2 text-xs leading-5">已开通能力</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {capabilities.map((capability) => (
                <Badge key={capability} variant="secondary">
                  {ADMIN_CAPABILITY_LABEL[capability] ?? capability}
                </Badge>
              ))}
            </div>
          </div>
        </aside>

        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
