import { createFileRoute } from '@tanstack/react-router'
import { FeedbackDetailPage } from '../features/admin/feedback-detail-page'

export const Route = createFileRoute('/admin/feedback/$feedbackId')({
  component: () => {
    const { feedbackId } = Route.useParams()
    // 父路由 validateSearch 归一后的查询条件，供详情页「返回队列」原样带回。
    const search = Route.useSearch()
    return <FeedbackDetailPage feedbackId={feedbackId} search={search} />
  },
})
