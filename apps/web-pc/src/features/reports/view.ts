/**
 * 举报域的纯展示逻辑：不 import React / 查询层，`view.test.ts` 直接测。
 */

/**
 * 提交失败的用户可见文案，按 `ApiError.code` 给固定文案。
 *
 * **不透传服务端 `message`**：那是给排查用的，既可能泄露内部信息、也不保证是中文。
 * `null` 覆盖非 `ApiError`（网络层失败 / 契约解析失败），统一给「稍后再试」。
 */
export function submitFailureText(code: string | null): string {
  if (code === 'REPORT_TARGET_NOT_FOUND') return '被举报的内容已不存在，无法提交举报'
  if (code === 'REPORT_SELF_TARGET') return '不能举报自己'
  if (code === 'REPORT_CONFLICT') return '这条举报的状态刚变过，请稍后再试'
  if (code === 'UNAUTHENTICATED') return '登录已过期，请重新登录后再提交'
  return '提交失败，请稍后再试'
}

/**
 * 提交成功文案。
 *
 * `created: false` 是**重复举报同一目标**（服务端把已有的未决单原样返回、不新增行），
 * 不是错误：端上要说清「已受理、无需重复提交」，不能让用户以为没提交上而反复点。
 */
export function submitSuccessText(created: boolean): string {
  return created
    ? '举报已提交，我们会核实后处理。处理进度可在「我的举报」查看。'
    : '你此前已举报过该目标，举报仍在审核中，无需重复提交。处理进度可在「我的举报」查看。'
}

/**
 * 能否举报某个用户：**不能举报自己**。
 *
 * 服务端对 `targetType === 'USER' && targetId === 自己` 直接 422 `REPORT_SELF_TARGET`，
 * 所以端上就不要给出这个入口 —— 让用户点完再吃一个错误是坏的交互。
 * `viewerId` 为 null（匿名或登录态未就绪）时返回 true，交给服务端的 401 兜底。
 */
export function canReportUser(viewerId: string | null, targetUserId: string): boolean {
  return viewerId === null || viewerId !== targetUserId
}

/** 列表脚行的编号截断：`rpt_01J8ZQ3XK7M2` → `rpt_01J8Z…K7M2`。 */
export function shortReportId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 9)}…${id.slice(-4)}`
}
