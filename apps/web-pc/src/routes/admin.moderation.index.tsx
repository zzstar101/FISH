import { createFileRoute } from '@tanstack/react-router'
import { ModerationPage } from '../features/admin/moderation-page'

export const Route = createFileRoute('/admin/moderation/')({
  component: () => {
    const search = Route.useSearch()
    return <ModerationPage search={search} />
  },
})
