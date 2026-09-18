import { createFileRoute } from '@tanstack/react-router'
import { UserDetailPage } from '../features/admin/user-detail-page'

export const Route = createFileRoute('/admin/users/$userId')({ component: UserDetailPage })
