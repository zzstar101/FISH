import { createFileRoute } from '@tanstack/react-router'
import { ListingsPage } from '../features/admin/listings-page'

export const Route = createFileRoute('/admin/listings/')({
  component: () => {
    const search = Route.useSearch()
    return <ListingsPage search={search} />
  },
})
