import { createFileRoute } from '@tanstack/react-router'
import { MyReportsPage } from '../features/reports/my-reports-page'

export const Route = createFileRoute('/my-reports')({ component: MyReportsPage })
