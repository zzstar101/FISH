import { ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '@fish/contracts/account-deletion/schema'
import { isApiError } from '@/lib/request'

/**
 * 注销页的纯逻辑（#464）。放在 `view.ts` 与页面分开，是为了让「什么时候允许提交」
 * 与「失败该说哪句话」这两件事不被 JSX 淹没 —— 它们各自对应一条验收要求：
 * 提交必须有明确确认，失败必须给出可行动的下一步。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 确认词比对（与 PC 端同口径，服务端仍会独立校验一遍）。
 *
 * 只 `trim` 两端：用户从聊天里复制常带尾随空格，但**中间不能容错** ——
 * 这是「明确确认」而不是模糊匹配。
 */
export function isConfirmPhrase(input: string): boolean {
  return input.trim() === ACCOUNT_DELETION_CONFIRMATION_PHRASE
}

/**
 * 冷静期剩余天数（向上取整：还剩 30 分钟也应显示「1 天」，显示「0 天」会让人以为已经注销）。
 *
 * `purgeScheduledAt` 为 null（理论不该出现）或解析失败时回 0，由 `coolingOffText` 兜底成
 * 「即将被注销」—— 宁可催得急一点，也不要让用户以为还有很多时间。
 */
export function coolingOffDays(purgeScheduledAt: string | null, nowMs: number): number {
  if (purgeScheduledAt === null) return 0
  const due = Date.parse(purgeScheduledAt)
  if (Number.isNaN(due)) return 0
  return Math.max(0, Math.ceil((due - nowMs) / DAY_MS))
}

export function coolingOffText(purgeScheduledAt: string | null, nowMs: number): string {
  const days = coolingOffDays(purgeScheduledAt, nowMs)
  if (days <= 0) return '冷静期已到期，账号即将被注销'
  return `冷静期剩余 ${days} 天`
}

/**
 * 一次账号作用域的异步任务：属于**哪个账号**、属于**哪一轮**（判据与
 * `features/reports/view.ts` 的 `ReportTask`、`pages/sell/view.ts` 的 `SellTask` 同源）。
 *
 * 注销页的读取、申请、撤回三件事都会改写「账号处于什么状态」这一屏最要紧的事实。
 * 只比对 `ownerId` 不够：`A → B → A` 时当前账号又变回 A，A 的迟到响应会被写进 A 的**新**会话，
 * 所以还要叠一个只在换号 / 卸载时前进的代次。
 */
export type DeletionTask = { ownerId: string; epoch: number }

export function beginDeletionTask(epoch: number, ownerId: string): DeletionTask {
  return { ownerId, epoch }
}

export function isDeletionTaskCurrent(
  task: DeletionTask,
  currentEpoch: number,
  currentOwnerId: string | null,
): boolean {
  return task.epoch === currentEpoch && task.ownerId === currentOwnerId
}

/** 渲染期换号判据（含冷启动 `unknown → authed` 那一次身份解析） */
export function deletionOwnerChanged(previous: string | null, next: string | null): boolean {
  return previous !== next
}

/**
 * 失败文案。三类业务错误各有各的下一步，不能都吞成「操作失败」：
 * - 未完成交易 / 封禁中：**原样透出服务端 message**（里面有对方昵称或封禁原因），
 *   这是用户唯一能据以行动的信息；
 * - 冷静期内被拦写：告诉用户还有「撤回」这条路；
 * - 其余：登录失效要引导重新登录，确认词错误要重述正确写法。
 */
export function deletionErrorMessage(error: unknown, fallback: string): string {
  if (!isApiError(error)) return fallback
  switch (error.code) {
    case 'ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION':
    case 'ACCOUNT_DELETION_BLOCKED_BANNED':
      return error.message
    case 'ACCOUNT_DELETION_PENDING':
      return '注销申请处理中，暂不能发布、留言、聊天或交易；你可以先撤回申请'
    case 'VALIDATION_FAILED':
      return `确认词不正确，请输入「${ACCOUNT_DELETION_CONFIRMATION_PHRASE}」`
    case 'UNAUTHENTICATED':
      return '登录状态已失效，请重新登录'
    default:
      return error.message
  }
}
