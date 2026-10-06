import { createFileRoute } from '@tanstack/react-router'
import { UsersPage } from '../features/admin/users-page'

export const Route = createFileRoute('/admin/users/')({
  component: () => {
    const search = Route.useSearch()
    return <UsersPage search={search} />
  },
})
