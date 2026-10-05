import { createFileRoute } from '@tanstack/react-router'
import { TransactionsPage } from '../features/admin/transactions-page'

export const Route = createFileRoute('/admin/transactions/')({
  component: () => {
    const search = Route.useSearch()
    return <TransactionsPage search={search} />
  },
})
