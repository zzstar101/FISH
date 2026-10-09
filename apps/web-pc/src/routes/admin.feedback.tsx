import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseFeedbackSearch } from '../features/admin/feedback-page'

export const Route = createFileRoute('/admin/feedback')({
  validateSearch: parseFeedbackSearch,
  component: () => <Outlet />,
})
