import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../features/shell/page-placeholder'

export const Route = createFileRoute('/listing/$listingId')({
  component: ListingDetailPage,
})

function ListingDetailPage() {
  const { listingId } = Route.useParams()
  return (
    <PagePlaceholder
      actionLabel="返回首页"
      description={`商品详情路由已接通，listingId = ${listingId}。详情接口、图片画廊和卖家面板将在下一个 Issue 接入。`}
      title="商品详情"
    />
  )
}
