import { ApiError } from '../../lib/api-client'

/**
 * Admin 域错误码 → 界面文案（#467）。
 *
 * 与其它域的 `api.ts` 错误映射同口径：调用方只依赖 `code` 分支，这里把「哪个码落到
 * 哪种界面」集中成纯函数。治理/审核/举报三组写操作的冲突（409）必须**如实展示**并
 * 提示刷新，不能吞成成功，也不能当成网络错误掩盖「已被他人处理」的事实。
 */

export type AdminLoadOutcome =
  | { kind: 'ok' }
  /** 已登录但不是管理员：整页权限态，不渲染任何后台数据。 */
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }

/** 只读查询的失败归类。403 `FORBIDDEN` 是管理后台的权限边界，单独成态。 */
export function adminLoadOutcome(error: unknown): AdminLoadOutcome {
  if (isApiError(error)) {
    if (error.status === 403 && error.code === 'FORBIDDEN') return { kind: 'forbidden' }
    if (error.status === 404) return { kind: 'error', message: '目标不存在或已被删除' }
    return { kind: 'error', message: error.message }
  }
  return { kind: 'error', message: '网络异常，请稍后重试' }
}

export type AdminActionOutcome = { message: string; conflict: boolean }

/** 治理写（下架/恢复/限制/封禁/解除）的失败文案。409 = 状态已被别人改掉，必须刷新。 */
export function governanceActionError(error: unknown): AdminActionOutcome {
  if (isApiError(error)) {
    switch (error.code) {
      case 'GOVERNANCE_TARGET_NOT_FOUND':
        return { message: '目标不存在或已被删除', conflict: false }
      case 'GOVERNANCE_SOURCE_REPORT_NOT_FOUND':
        return { message: '关联的举报单不存在，请核对后重试', conflict: false }
      case 'GOVERNANCE_SOURCE_REPORT_MISMATCH':
        return { message: '关联的举报单与本次治理目标不匹配', conflict: false }
      case 'GOVERNANCE_SELF_TARGET':
        return { message: '不能对自己执行治理操作', conflict: false }
      case 'GOVERNANCE_CONFLICT':
        return { message: '目标状态已被其他管理员变更，请刷新后重试', conflict: true }
      case 'USER_GUARD_BUSY':
        return { message: '系统繁忙，请稍后重试', conflict: false }
      case 'VALIDATION_FAILED':
        return { message: validationMessage(error), conflict: false }
      default:
        return { message: error.message, conflict: false }
    }
  }
  return { message: '网络异常，请稍后重试', conflict: false }
}

/** 人工审核决定的失败文案。同 key 重试撞 409 = 已被处理（含被自己此前的成功请求）。 */
export function moderationDecisionError(error: unknown): AdminActionOutcome {
  if (isApiError(error)) {
    switch (error.code) {
      case 'MODERATION_CONFLICT':
        return { message: '该审核记录已被其他管理员处理，请刷新后重试', conflict: true }
      case 'ADMIN_NOT_FOUND':
        return { message: '审核记录不存在或已被删除', conflict: false }
      case 'VALIDATION_FAILED':
        return { message: validationMessage(error), conflict: false }
      default:
        return { message: error.message, conflict: false }
    }
  }
  return { message: '网络异常，请稍后重试', conflict: false }
}

/** 处理举报的失败文案。重复处理 → 409（无幂等键，状态机拒绝）。 */
export function reportHandleError(error: unknown): AdminActionOutcome {
  if (isApiError(error)) {
    switch (error.code) {
      case 'REPORT_CONFLICT':
        return { message: '该举报已被处理，请刷新后重试', conflict: true }
      case 'REPORT_NOT_FOUND':
        return { message: '举报不存在或已被删除', conflict: false }
      case 'VALIDATION_FAILED':
        return { message: validationMessage(error), conflict: false }
      default:
        return { message: error.message, conflict: false }
    }
  }
  return { message: '网络异常，请稍后重试', conflict: false }
}

/** 处理争议的失败文案。重复处理 / 已被撤回 → 409（无幂等键，状态机拒绝）。 */
export function disputeResolveError(error: unknown): AdminActionOutcome {
  if (isApiError(error)) {
    switch (error.code) {
      case 'DISPUTE_CONFLICT':
      case 'DISPUTE_NOT_PENDING':
        return { message: '该争议已被处理或已撤回，请刷新后重试', conflict: true }
      case 'DISPUTE_NOT_FOUND':
        return { message: '争议不存在或已被删除', conflict: false }
      case 'VALIDATION_FAILED':
        return { message: validationMessage(error), conflict: false }
      default:
        return { message: error.message, conflict: false }
    }
  }
  return { message: '网络异常，请稍后重试', conflict: false }
}

/** 422 details 的第一条透传（服务端给了 field 级文案时优先用它）。 */
function validationMessage(error: ApiError): string {
  const first = error.details?.[0]
  if (first === undefined) return '输入不符合要求，请检查后重试'
  return `${first.field}：${first.message}`
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}
