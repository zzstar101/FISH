import { createFileRoute } from '@tanstack/react-router'
import { UserDetailPage } from '../features/admin/user-detail-page'

export const Route = createFileRoute('/admin/users/$userId')({
  component: () => {
    const { userId } = Route.useParams()
    // 父路由 validateSearch 归一后的查询条件，供详情页「返回列表」原样带回（#467 五审 P2）。
    const search = Route.useSearch()
    return <UserDetailPage search={search} userId={userId} />
  },
})
