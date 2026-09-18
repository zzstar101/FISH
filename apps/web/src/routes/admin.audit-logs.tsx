import { createFileRoute } from '@tanstack/react-router'
import { AuditLogsPage } from '../features/admin/audit-logs-page'

export const Route = createFileRoute('/admin/audit-logs')({ component: AuditLogsPage })
