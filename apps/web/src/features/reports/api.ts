import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import {
  type ReportCreateInput,
  ReportCreateInputSchema,
  type ReportCreateResponse,
  ReportCreateResponseSchema,
  type ReportListResponse,
  ReportListResponseSchema,
} from '@fish/contracts/reports/schema'
import { apiRequest } from '../../lib/api-client'

export async function submitReport(input: ReportCreateInput): Promise<ReportCreateResponse> {
  return ReportCreateResponseSchema.parse(
    await apiRequest(REPORT_ROUTES.create, {
      method: 'POST',
      body: JSON.stringify(ReportCreateInputSchema.parse(input)),
    }),
  )
}

export async function fetchMyReports(cursor: string | null = null): Promise<ReportListResponse> {
  const query = new URLSearchParams({ limit: '20' })
  if (cursor !== null) query.set('cursor', cursor)
  return ReportListResponseSchema.parse(await apiRequest(`${REPORT_ROUTES.mine}?${query}`))
}
