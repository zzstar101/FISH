import { Badge } from '@fish/ui/badge'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, FileWarning, Package, ShieldAlert, UserPlus, Users } from 'lucide-react'
import { formatDateTime } from './display'
import { useAdminOverview } from './queries'

/**
 * 后台概览（#73 设计 §4.5）：固定口径的预定义聚合指标，不接受任意查询表达式。
 * #74 落地的「待人工审核 / 近 7 日审核通过·拦截」指标在契约扩展后再加。
 */
export function OverviewPage() {
  const overview = useAdminOverview()

  if (overview.isPending) return <LoadingState label="正在加载概览…" />
  if (overview.isError) {
    return <ErrorState message="概览加载失败" onRetry={() => void overview.refetch()} />
  }

  const data = overview.data

  const stats = [
    { icon: Users, label: '用户总数', value: data.totalUsers, to: '/admin/users' as const },
    {
      icon: UserPlus,
      label: '近 24h 新增用户',
      value: data.newUsersLast24h,
      to: '/admin/users' as const,
    },
    {
      icon: Package,
      label: '在售商品',
      value: data.activeListings,
      to: '/admin/listings' as const,
    },
    {
      icon: CheckCircle2,
      label: '已完成交易',
      value: data.completedTransactions,
      to: '/admin/transactions' as const,
    },
    // #73 治理半场 PR4：四个新指标。全部是后端全量 count(*)，不拿当前页条数冒充
    // 总量（Overview 没有任何筛选参数，口径必须稳定）。
    {
      icon: FileWarning,
      label: '待人工审核',
      value: data.pendingReviewRecords,
      to: '/admin/moderation' as const,
    },
    {
      icon: FileWarning,
      label: '待处理举报',
      value: data.pendingReports,
      to: '/admin/reports' as const,
    },
    {
      icon: ShieldAlert,
      label: '近 7 日举报',
      value: data.reportsLast7d,
      to: '/admin/reports' as const,
    },
    {
      icon: ShieldAlert,
      label: '生效中限制',
      value: data.activeRestrictions,
      to: '/admin/users' as const,
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-lg">平台概览</h1>
        <p className="mt-1 text-sm text-ink-3">
          固定口径聚合数据 · 更新时间 {formatDateTime(new Date().toISOString())}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(({ icon: Icon, label, value, to }) => (
          <Link
            className="rounded-2xl border border-line bg-surface p-4 transition-shadow hover:shadow-sm"
            key={label}
            to={to}
          >
            <Icon className="size-5 text-brand" />
            <p className="mt-3 font-bold text-2xl">{value}</p>
            <p className="mt-1 text-sm text-ink-3">{label}</p>
          </Link>
        ))}
      </div>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-2 font-semibold text-[15px]">说明</h2>
        <ul className="space-y-1 text-sm text-ink-2">
          <li>· 用户总数含全部注册用户；近 24 小时按注册时间统计。</li>
          <li>· 在售商品 = 商品状态为「在售」的总数；完成交易 = 交易状态为「已完成」。</li>
          <li>· 审核队列、人工决定与审核时间线见「审核队列」；审核决定会写入审计日志。</li>
          <li>
            · 待处理举报只数 `PENDING`；近 7
            日举报含已处理；生效中限制按限制记录计，同一用户被限制发布与封禁算两条。
          </li>
        </ul>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-semibold text-[15px]">快捷入口</h2>
        <div className="flex flex-wrap gap-2">
          <Link className="rounded-lg bg-brand px-3 py-1.5 text-sm text-white" to="/admin/users">
            用户查询
          </Link>
          <Link className="rounded-lg bg-brand px-3 py-1.5 text-sm text-white" to="/admin/listings">
            商品与审核队列
          </Link>
          <Link
            className="rounded-lg bg-brand px-3 py-1.5 text-sm text-white"
            to="/admin/audit-logs"
          >
            操作日志
          </Link>
        </div>
      </section>
    </div>
  )
}

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge shape="pill" variant={role === 'ADMIN' ? 'default' : 'secondary'}>
      {role === 'ADMIN' ? '管理员' : '用户'}
    </Badge>
  )
}
