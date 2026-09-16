import { createFileRoute } from '@tanstack/react-router'
import { type AdminListingsSearch, ListingsPage } from '../features/admin/listings-page'

const STATUSES = ['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'] as const

// index 路由（不是 layout）：`/admin/listings` 与 `/admin/listings/$listingId` 互为兄弟，都挂在 `/admin` 布局下。
// 写成 layout 会让详情页成为它的子路由，而本组件不渲染 `<Outlet/>`，详情页将永远不挂载（见 routes.structure.test.ts）。
export const Route = createFileRoute('/admin/listings/')({
  // 筛选条件写入 URL（设计 §7），便于复制定位；值域白名单，非法值退回 undefined。
  validateSearch: (search: Record<string, unknown>): AdminListingsSearch => {
    const out: AdminListingsSearch = {}
    if (typeof search.q === 'string' && search.q.trim() !== '') out.q = search.q.trim()
    if (STATUSES.includes(search.status as (typeof STATUSES)[number])) {
      out.status = search.status as string
    }
    return out
  },
  component: () => {
    const search = Route.useSearch()
    return <ListingsPage search={search} />
  },
})
