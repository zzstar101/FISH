import { ReportSchema } from '@fish/contracts/reports/schema'
import { createFileRoute } from '@tanstack/react-router'
import { ListingDetailPage } from '../features/admin/listing-detail-page'

export const Route = createFileRoute('/admin/listings/$listingId')({
  validateSearch: (search: Record<string, unknown>): { sourceReportId?: string } => {
    const report = ReportSchema.shape.id.safeParse(search.sourceReportId)
    return report.success ? { sourceReportId: report.data } : {}
  },
  component: ListingDetailPage,
})
