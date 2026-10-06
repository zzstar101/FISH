import type { AdminOverview } from '@fish/contracts/admin/schema'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { ForbiddenInline } from './admin-filter'
import { adminLoadView } from './admin-messages'
import { useAdminOverview } from './admin-queries'

/**
 * 平台概览（#467 验收「概览：展示接口提供的全量统计」）。八个卡片与
 * `AdminOverviewSchema` 一一对应，**没有的口径不画**（契约注释明确拒收任意聚合）。
 * 待审核 / 待处理举报两张卡可点进对应队列。
 */
export function OverviewPage() {
  const overview = useAdminOverview()

  if (overview.isPending) return <LoadingState label="正在加载平台概览…" />
  if (overview.isError) {
    const view = adminLoadView(overview.error, '平台概览加载失败')
    // 403 是权限边界（#467 五审 P3）：给整页权限态，别让管理员对着「重试」反复撞墙。
    if (view.kind === 'forbidden') return <ForbiddenInline />
    // 概览是固定端点、没有「实例被删」的语义：404 说明路由/部署错配，重试同样救不回来。
    if (view.kind === 'notFound')
      return <ErrorState message="接口不存在，请确认后端版本与部署路径" />
    return <ErrorState message={view.message} onRetry={() => void overview.refetch()} />
  }

  return <OverviewView overview={overview.data} />
}

export function OverviewView({ overview }: { overview: AdminOverview }) {
  const cards: ReadonlyArray<{ label: string; value: number; to: string | null }> = [
    { label: '累计用户', value: overview.totalUsers, to: null },
    { label: '近 24h 新增用户', value: overview.newUsersLast24h, to: null },
    { label: '在售商品', value: overview.activeListings, to: '/admin/listings' },
    { label: '完成交易', value: overview.completedTransactions, to: '/admin/transactions' },
    { label: '待人工审核', value: overview.pendingReviewRecords, to: '/admin/moderation' },
    { label: '待处理举报', value: overview.pendingReports, to: '/admin/reports' },
    { label: '近 7 日举报', value: overview.reportsLast7d, to: '/admin/reports' },
    { label: '生效中限制', value: overview.activeRestrictions, to: null },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">平台概览</h1>
        <p className="mt-1.5 text-ink-3 text-sm">固定口径的聚合指标，来自服务端预定义统计。</p>
      </div>

      {overview.totalUsers === 0 ? (
        <EmptyState
          description="还没有任何用户注册；指标会随真实数据出现"
          emoji="📊"
          title="暂无数据"
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {cards.map((card) => (
            <OverviewCard card={card} key={card.label} />
          ))}
        </div>
      )}
    </div>
  )
}

function OverviewCard({ card }: { card: { label: string; value: number; to: string | null } }) {
  const body = (
    <Card className="gap-1 border border-line p-5 transition-colors hover:border-brand/40">
      <p className="text-ink-3 text-sm">{card.label}</p>
      <p className="font-bold text-3xl tracking-tight">{card.value}</p>
    </Card>
  )
  return card.to === null ? <div>{body}</div> : <Link to={card.to}>{body}</Link>
}
