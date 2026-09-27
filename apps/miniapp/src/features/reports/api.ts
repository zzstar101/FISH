/**
 * 举报域 API（#252 接线：提交举报 + 我的举报）。
 *
 * 路径一律取自契约常量（`@fish/contracts/reports/routes`），响应一律用契约 schema 收口，
 * 形状漂移在解析处就炸，而不是渲染到页面上才炸 —— 与 `features/listing/api.ts` 同一口径。
 *
 * 本模块只做「发请求 + 解析」：不认构建模式、不碰演示数据（回退判据在 `./load`），
 * 也不做文案（文案在 `./meta`）。这样 `tests/reports.test.ts` 能直接对着契约测它。
 */
import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import {
  type ReportCreateInput,
  ReportCreateInputSchema,
  type ReportCreateResponse,
  ReportCreateResponseSchema,
  type ReportListResponse,
  ReportListResponseSchema,
} from '@fish/contracts/reports/schema'
import { apiRequest } from '@/lib/request'

/**
 * `GET /reports/mine` 单页上限。契约 `ReportMineQuerySchema` 的 `limit` 上限是 50，
 * 超了会被 422 拒掉，所以这里写死 50 并在分页时靠 `cursor` 续。
 */
const PAGE_SIZE = 50

/**
 * 提交举报（写路径）。
 *
 * 重复提交同一个未决目标**不是错误**：后端返回 200 + `created: false`
 * （契约 `ReportCreateResponseSchema`），调用方据此提示「此前已受理」而不是再报一次
 * 「已提交」。其余失败一律抛 `ApiError`，`code` 见契约 `ReportErrorCodeSchema`
 * （`REPORT_TARGET_NOT_FOUND` / `REPORT_SELF_TARGET` / `REPORT_CONFLICT`），
 * 到用户可见文案的映射在 `./meta` 的 `submitFailureText`。
 *
 * 入参先过一遍 `ReportCreateInputSchema`：目标 ID 必须是 `lst_` / `usr_` 公开 ID 且与
 * `targetType` 对得上（契约 `superRefine`），裸 UUID 或错前缀在**发请求之前**就被挡下 ——
 * 这正是 #252 第 ④ 项要消除的假设。
 */
export async function submitReport(input: ReportCreateInput): Promise<ReportCreateResponse> {
  const payload = await apiRequest(REPORT_ROUTES.create, {
    method: 'POST',
    body: ReportCreateInputSchema.parse(input),
  })
  return ReportCreateResponseSchema.parse(payload)
}

/** 拉一页「我的举报」。`cursor` 是不透明串，只能原样回传上一页的 `nextCursor`。 */
export async function fetchMyReportPage(cursor?: string): Promise<ReportListResponse> {
  const payload = await apiRequest(REPORT_ROUTES.mine, {
    query: { limit: PAGE_SIZE, cursor },
  })
  return ReportListResponseSchema.parse(payload)
}
