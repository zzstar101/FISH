import { createFileRoute } from '@tanstack/react-router'
import { ReportDetailPage } from '../features/admin/report-detail-page'

export const Route = createFileRoute('/admin/reports/$reportId')({
  component: () => {
    const { reportId } = Route.useParams()
    // 父路由 validateSearch 归一后的查询条件，供详情页「返回队列」原样带回（#467 五审 P2）。
    const search = Route.useSearch()
    return <ReportDetailPage reportId={reportId} search={search} />
  },
})
