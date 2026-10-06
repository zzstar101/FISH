import { createFileRoute } from '@tanstack/react-router'
import { ListingDetailPage } from '../features/admin/listing-detail-page'

export const Route = createFileRoute('/admin/listings/$listingId')({
  component: () => {
    const { listingId } = Route.useParams()
    // 父路由 validateSearch 归一后的查询条件，供详情页「返回列表」原样带回（#467 五审 P2）。
    const search = Route.useSearch()
    return <ListingDetailPage listingId={listingId} search={search} />
  },
})
