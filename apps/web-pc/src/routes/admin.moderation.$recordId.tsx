import { createFileRoute } from '@tanstack/react-router'
import { ModerationDetailPage } from '../features/admin/moderation-detail-page'

export const Route = createFileRoute('/admin/moderation/$recordId')({
  component: () => {
    const { recordId } = Route.useParams()
    // 读取父路由 validateSearch 归一后的 tab，让「返回」回到来处（待审队列 / 历史检索）。
    const { tab } = Route.useSearch()
    return <ModerationDetailPage recordId={recordId} tab={tab} />
  },
})
