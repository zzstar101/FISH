import { ApiError } from '../../lib/api-client'

/**
 * Admin 域错误码 → 界面文案（#467）。
 *
 * 与其它域的 `api.ts` 错误映射同口径：调用方只依赖 `code` 分支，这里把「哪个码落到
 * 哪种界面」集中成纯函数。治理/审核/举报/争议四组写操作的冲突（409）必须**如实展示**并
 * 提示刷新，不能吞成成功，也不能当成网络错误掩盖「已被他人处理」的事实。
 */

export type AdminLoadOutcome =
  | { kind: 'ok' }
  /** 已登录但不是管理员：整页权限态，不渲染任何后台数据。 */
  | { kind: 'forbidden' }
  /** 目标不存在（404）：重试改变不了结果，详情页据此给「返回列表」而不是重试。 */
  | { kind: 'notFound' }
  | { kind: 'error'; message: string }

/** 只读查询的失败归类。403 `FORBIDDEN` 是管理后台的权限边界，404 是目标级缺失。 */
export function adminLoadOutcome(error: unknown): AdminLoadOutcome {
  if (isApiError(error)) {
    if (error.status === 403 && error.code === 'FORBIDDEN') return { kind: 'forbidden' }
    if (error.status === 404) return { kind: 'notFound' }
    return { kind: 'error', message: error.message }
  }
  return { kind: 'error', message: '网络异常，请稍后重试' }
}

/** 只读页失败态 → 渲染指令（#467 五审 P3）。 */
export type AdminLoadView =
  /** 403：整页权限态，**不给重试**（权限不会因为再点一次而改变）。 */
  | { kind: 'forbidden' }
  /** 404：整页缺失态，**不给重试**（已删除的目标不会回来）。 */
  | { kind: 'notFound' }
  /** 其它失败：可展示文案；只有这一类带「重试」。 */
  | { kind: 'error'; message: string }

/**
 * 把只读查询的失败翻译成「渲染什么」。四个详情页与概览/指标页都走这一条，
 * 免得六个页面各手写一遍三分法（`outcome.kind`）+ 兜底文案而漏掉某一支。
 * 传入的一定是 `isError` 分支里的 error，`ok` 只作类型上的兜底。
 */
export function adminLoadView(error: unknown, fallback: string): AdminLoadView {
  const outcome = adminLoadOutcome(error)
  if (outcome.kind === 'forbidden') return { kind: 'forbidden' }
  if (outcome.kind === 'notFound') return { kind: 'notFound' }
  return { kind: 'error', message: outcome.kind === 'error' ? outcome.message : fallback }
}

export type AdminActionOutcome = { message: string; conflict: boolean }

/**
 * 写操作失败码 → 文案的统一骨架（#465 审查发现 Repeated Switches：治理/审核/举报/争议
 * 四个域各抄一遍同形 switch，第 4 份就是本 PR 加的）。
 *
 * 各域只提供「自己特有的码 → 文案」；三类兜底——`VALIDATION_FAILED` 的 field 级文案、
 * 未知码透传 `message`、非 `ApiError` 归网络异常——全仓同口径，只在这里写一次。
 * 冲突（409）必须如实标记 `conflict: true` 并提示刷新，不能吞成成功、也不能当网络错误掩盖
 * 「已被他人处理」的事实。
 */
function actionError(
  error: unknown,
  cases: Readonly<Record<string, AdminActionOutcome>>,
): AdminActionOutcome {
  if (!isApiError(error)) return { message: '网络异常，请稍后重试', conflict: false }
  if (error.code === 'VALIDATION_FAILED') {
    return { message: validationMessage(error), conflict: false }
  }
  return cases[error.code] ?? { message: error.message, conflict: false }
}

/** 治理写（下架/恢复/限制/封禁/解除）的失败文案。409 = 状态已被别人改掉，必须刷新。 */
export function governanceActionError(error: unknown): AdminActionOutcome {
  return actionError(error, {
    GOVERNANCE_TARGET_NOT_FOUND: { message: '目标不存在或已被删除', conflict: false },
    GOVERNANCE_SOURCE_REPORT_NOT_FOUND: {
      message: '关联的举报单不存在，请核对后重试',
      conflict: false,
    },
    GOVERNANCE_SOURCE_REPORT_MISMATCH: {
      message: '关联的举报单与本次治理目标不匹配',
      conflict: false,
    },
    GOVERNANCE_SELF_TARGET: { message: '不能对自己执行治理操作', conflict: false },
    GOVERNANCE_CONFLICT: {
      message: '目标状态已被其他管理员变更，请刷新后重试',
      conflict: true,
    },
    USER_GUARD_BUSY: { message: '系统繁忙，请稍后重试', conflict: false },
  })
}

/** 人工审核决定的失败文案。同 key 重试撞 409 = 已被处理（含被自己此前的成功请求）。 */
export function moderationDecisionError(error: unknown): AdminActionOutcome {
  return actionError(error, {
    MODERATION_CONFLICT: {
      message: '该审核记录已被其他管理员处理，请刷新后重试',
      conflict: true,
    },
    ADMIN_NOT_FOUND: { message: '审核记录不存在或已被删除', conflict: false },
  })
}

/** 处理举报的失败文案。重复处理 → 409（无幂等键，状态机拒绝）。 */
export function reportHandleError(error: unknown): AdminActionOutcome {
  return actionError(error, {
    REPORT_CONFLICT: { message: '该举报已被处理，请刷新后重试', conflict: true },
    REPORT_NOT_FOUND: { message: '举报不存在或已被删除', conflict: false },
  })
}

/** 处理争议的失败文案。重复处理 / 已被撤回 → 409（无幂等键，状态机拒绝）。 */
export function disputeResolveError(error: unknown): AdminActionOutcome {
  return actionError(error, {
    DISPUTE_CONFLICT: { message: '该争议已被处理或已撤回，请刷新后重试', conflict: true },
    DISPUTE_NOT_PENDING: { message: '该争议已被处理或已撤回，请刷新后重试', conflict: true },
    DISPUTE_NOT_FOUND: { message: '争议不存在或已被删除', conflict: false },
  })
}

/** 处理反馈的失败文案。重复处理 → 409（无幂等键，状态机拒绝）。 */
export function feedbackHandleError(error: unknown): AdminActionOutcome {
  return actionError(error, {
    FEEDBACK_CONFLICT: { message: '该反馈已被处理，请刷新后重试', conflict: true },
    FEEDBACK_NOT_FOUND: { message: '反馈不存在或已被删除', conflict: false },
  })
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
