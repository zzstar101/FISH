import { createFileRoute } from '@tanstack/react-router'
import { type AdminReportsSearch, ReportsQueuePage } from '../features/admin/reports-queue-page'

const STATUSES = ['PENDING', 'HANDLED', 'REJECTED'] as const
const TARGET_TYPES = ['LISTING', 'USER'] as const
const REASONS = [
  'MISLEADING',
  'PROHIBITED',
  'FRAUD',
  'SPAM',
  'HARASSMENT',
  'IMPERSONATION',
  'ABUSE',
  'OTHER',
] as const

// index 路由（不是 layout）：`/admin/reports` 与 `/admin/reports/$reportId` 互为兄弟，都挂在
// `/admin` 布局下。写成 layout 会让详情页成为它的子路由而永不挂载（见 routes.structure.test.ts）。
export const Route = createFileRoute('/admin/reports/')({
  // 筛选条件写入 URL（#73 设计 §7）：刷新 / 复制都能复现同一组筛选；值域白名单，非法值退回 undefined。
  validateSearch: (search: Record<string, unknown>): AdminReportsSearch => {
    const out: AdminReportsSearch = {}
    if (STATUSES.includes(search.status as (typeof STATUSES)[number]))
      out.status = search.status as string
    if (TARGET_TYPES.includes(search.targetType as (typeof TARGET_TYPES)[number]))
      out.targetType = search.targetType as string
    if (REASONS.includes(search.reason as (typeof REASONS)[number]))
      out.reason = search.reason as string
    return out
  },
  component: () => {
    const search = Route.useSearch()
    return <ReportsQueuePage search={search} />
  },
})
