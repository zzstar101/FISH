import { createFileRoute } from '@tanstack/react-router'
import { ReportDetailPage } from '../features/admin/report-detail-page'

export const Route = createFileRoute('/admin/reports/$reportId')({
  component: () => {
    const { reportId } = Route.useParams()
    return <ReportDetailPage reportId={reportId} />
  },
})
