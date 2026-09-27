import { createFileRoute } from '@tanstack/react-router'
import { PublishPage } from '../features/publish/publish-page'

export const Route = createFileRoute('/publish')({
  component: PublishPage,
})
