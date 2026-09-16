import { createFileRoute } from '@tanstack/react-router'
import { type AdminListingsSearch, ListingsPage } from '../features/admin/listings-page'

const STATUSES = ['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'] as const

export const Route = createFileRoute('/admin/listings')({
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
