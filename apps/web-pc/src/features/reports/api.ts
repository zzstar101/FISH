import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import {
  type ReportCreateInput,
  type ReportCreateResponse,
  ReportCreateResponseSchema,
  type ReportListResponse,
  ReportListResponseSchema,
} from '@fish/contracts/reports/schema'
import { apiRequest } from '../../lib/api-client'

/** 「我的举报」单页条数（契约 `ReportMineQuerySchema.limit` 服务端封顶 50）。 */
export const REPORT_PAGE_LIMIT = 20

/**
 * 提交举报：`201` 新建 / `200` 复用同一目标的未决单（`created: false`）。
 *
 * 两者都算**受理成功**——契约刻意不用 409 表达重复，因为超时重试在客户端看来也是
 * 一次失败，而举报其实已经受理了。调用方只看 `created` 决定文案，不看状态码。
 */
export async function submitReport(input: ReportCreateInput): Promise<ReportCreateResponse> {
  const payload = await apiRequest(REPORT_ROUTES.create, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return ReportCreateResponseSchema.parse(payload)
}

export async function fetchMyReports(
  cursor?: string,
  limit = REPORT_PAGE_LIMIT,
): Promise<ReportListResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor !== undefined) params.set('cursor', cursor)
  const payload = await apiRequest(`${REPORT_ROUTES.mine}?${params.toString()}`)
  return ReportListResponseSchema.parse(payload)
}
