import { createFileRoute } from '@tanstack/react-router'
import { BlockedPage } from '../features/blocks/blocked-page'

export const Route = createFileRoute('/blocked')({
  component: BlockedPage,
})
