import { createFileRoute } from '@tanstack/react-router'
import { TransactionsPage } from '../features/admin/transactions-page'

export const Route = createFileRoute('/admin/transactions')({ component: TransactionsPage })
