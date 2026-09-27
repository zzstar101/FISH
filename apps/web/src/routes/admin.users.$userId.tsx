import { ReportSchema } from '@fish/contracts/reports/schema'
import { createFileRoute } from '@tanstack/react-router'
import { UserDetailPage } from '../features/admin/user-detail-page'

export const Route = createFileRoute('/admin/users/$userId')({
  validateSearch: (search: Record<string, unknown>): { sourceReportId?: string } => {
    const report = ReportSchema.shape.id.safeParse(search.sourceReportId)
    return report.success ? { sourceReportId: report.data } : {}
  },
  component: UserDetailPage,
})
