import { createFileRoute } from '@tanstack/react-router'
import { WishModerationPage } from '../features/admin/wish-moderation-page'

export const Route = createFileRoute('/admin/wishes-moderation')({
  component: () => <WishModerationPage />,
})
