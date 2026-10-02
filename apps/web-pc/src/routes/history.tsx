import { createFileRoute } from '@tanstack/react-router'
import { HistoryPage } from '../features/view-history/history-page'

export const Route = createFileRoute('/history')({
  component: HistoryPage,
})
