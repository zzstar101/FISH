import { createFileRoute } from '@tanstack/react-router'
import { type AdminUsersSearch, UsersPage } from '../features/admin/users-page'

const ROLES = ['USER', 'ADMIN'] as const

export const Route = createFileRoute('/admin/users')({
  // 筛选条件写入 URL（设计 §7），便于复制定位；值域白名单，非法值退回 undefined。
  validateSearch: (search: Record<string, unknown>): AdminUsersSearch => {
    const out: AdminUsersSearch = {}
    if (typeof search.q === 'string' && search.q.trim() !== '') out.q = search.q.trim()
    if (ROLES.includes(search.role as (typeof ROLES)[number])) out.role = search.role as string
    return out
  },
  component: () => {
    const search = Route.useSearch()
    return <UsersPage search={search} />
  },
})
