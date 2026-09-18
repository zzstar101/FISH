import { createFileRoute } from '@tanstack/react-router'
import { OverviewPage } from '../features/admin/overview-page'

export const Route = createFileRoute('/admin/')({ component: OverviewPage })
