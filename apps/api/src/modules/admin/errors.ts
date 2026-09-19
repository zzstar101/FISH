import type { AdminErrorCode } from '@fish/contracts/admin/schema'

/**
 * Admin 域的失败信号：service / middleware 只负责抛它，HTTP 状态码与响应体由 router 统一翻译。
 * 这样「错误码 ↔ 状态码」的映射只有一处（与 auth / listings 的 `*Error` 同一取舍）。
 *
 * - `FORBIDDEN`（403）：已登录但非 Admin（`requireAdmin` 抛的最多的一种）。
 * - `ADMIN_NOT_FOUND`（404）：管理查询目标（用户 / 商品）不存在。
 * - `VALIDATION_FAILED`（422）：**领域层**的入参不合法（如非法游标），
 *   与 router 的 zod 校验共用同一个系统错误码。
 */
export class AdminError extends Error {
  constructor(
    readonly code: AdminErrorCode | 'VALIDATION_FAILED',
    readonly status: 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'AdminError'
  }
}
