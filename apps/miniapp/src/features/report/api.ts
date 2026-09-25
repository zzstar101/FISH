/**
 * 用户端举报的请求层（#73 治理半场）。
 *
 * 后端能力由 Issue #73 落地：契约 `@fish/contracts/reports/schema`，API
 * `apps/api/src/modules/reports`。本模块是**唯一**的举报传输入口（路径常量取自
 * `@fish/contracts/reports/routes`，禁止硬编码），响应用契约 schema 收口 ——
 * 形状漂移在解析处就炸，而不是渲染到页面上才炸。范式同
 * `features/listing/comments.ts`。
 *
 * ## 两个必须知道的返回口径
 *
 * 1. **重复举报也是成功**：同一举报人 + 同一目标的未决单已存在时，服务端返回 **200** +
 *    `created: false` 与**已存在的那张单**，不新增行也不报冲突（契约
 *    `ReportCreateResponseSchema` 的注释：网络超时重试在客户端看来是一次失败，而举报
 *    其实已经受理了）。所以「已提交过」**不是失败分支**，调用方不能抛错、更不能提示失败。
 * 2. **新建是 201，重复是 200**：两者都是 2xx，`apiRequest` 都不会抛；判断「这次是不是
 *    新建」只能看 `created`，不能看状态码。
 *
 * ## 失败口径
 *
 * 与 `features/fetchers.ts` 同口径：接口失败**原样抛出**，不返回任何 fixture。
 * 未登录（401）由挂载点的 `requireAuth` 给出，见 `apps/api/src/app.ts`。
 */
import { REPORT_ROUTES } from '@fish/contracts/reports/routes'
import {
  type ReportCreateInput,
  type ReportCreateResponse,
  ReportCreateResponseSchema,
} from '@fish/contracts/reports/schema'
import { apiRequest } from '@/lib/request'

/**
 * 提交一次举报，返回服务端受理结果。
 *
 * `detailText` 传空串等同于不传（契约是 `trim().min(1).max(200).optional()`，
 * 空串会被服务端以 422 拒掉），所以这里先把空白去掉再决定带不带这个键。
 */
export async function submitReport(input: ReportCreateInput): Promise<ReportCreateResponse> {
  const detailText = input.detailText?.trim()
  const body: ReportCreateInput =
    detailText === undefined || detailText === ''
      ? { targetType: input.targetType, targetId: input.targetId, reason: input.reason }
      : { ...input, detailText }
  const payload = await apiRequest(REPORT_ROUTES.create, { method: 'POST', body })
  return ReportCreateResponseSchema.parse(payload)
}
