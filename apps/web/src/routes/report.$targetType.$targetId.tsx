import { createFileRoute } from '@tanstack/react-router'
import { ReportFormPage } from '../features/reports/report-form-page'

export const Route = createFileRoute('/report/$targetType/$targetId')({
  component: ReportRoute,
})

function ReportRoute() {
  const { targetType, targetId } = Route.useParams()
  return <ReportFormPage targetId={targetId} targetType={targetType} />
}
