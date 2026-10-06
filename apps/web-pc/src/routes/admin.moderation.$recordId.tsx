import { createFileRoute } from '@tanstack/react-router'
import { ModerationDetailPage } from '../features/admin/moderation-detail-page'

export const Route = createFileRoute('/admin/moderation/$recordId')({
  component: () => {
    const { recordId } = Route.useParams()
    // 读取父路由 validateSearch 归一后的整份查询条件（tab + 判定/商品/关键词/时间段），
    // 让「返回」回到来处并恢复检索条件（#467 五审 P2）。
    const search = Route.useSearch()
    return <ModerationDetailPage recordId={recordId} search={search} />
  },
})
