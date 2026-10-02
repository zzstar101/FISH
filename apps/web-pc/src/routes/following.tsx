import { createFileRoute } from '@tanstack/react-router'
import { FollowingPage } from '../features/follows/following-page'

export const Route = createFileRoute('/following')({
  component: FollowingPage,
})
