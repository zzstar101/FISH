import { createFileRoute } from '@tanstack/react-router'
import { ProfileModerationPage } from '../features/admin/profile-moderation-page'

export const Route = createFileRoute('/admin/profile-moderation')({
  component: () => <ProfileModerationPage />,
})
