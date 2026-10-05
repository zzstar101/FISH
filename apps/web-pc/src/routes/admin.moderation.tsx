import { createFileRoute, Outlet } from '@tanstack/react-router'
import { parseModerationSearch } from '../features/admin/moderation-page'

export const Route = createFileRoute('/admin/moderation')({
  validateSearch: parseModerationSearch,
  component: () => <Outlet />,
})
