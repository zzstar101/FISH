import { createFileRoute } from '@tanstack/react-router'
import { MyCommentsPage } from '../features/my-comments/my-comments-page'

export const Route = createFileRoute('/comments')({ component: MyCommentsPage })
