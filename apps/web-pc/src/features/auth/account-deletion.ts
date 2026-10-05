import { ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '@fish/contracts/account-deletion/schema'
import { ApiError } from '../../lib/api-client'

/**
 * 二次确认是否已满足。
 *
 * 比对前去掉首尾空白：移动端输入法常带尾随空格，而服务端 `z.literal` 是逐字比对。
 * 端上先 trim 再比对、并把 trim 过的值作为即时反馈依据，能避免「明明打对了却说自己错」。
 */
export function matchesDeletionConfirmation(input: string): boolean {
  return input.trim() === ACCOUNT_DELETION_CONFIRMATION_PHRASE
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 冷静期剩余天数（向上取整，不小于 0）。
 *
 * 用 `purgeScheduledAt` 反算而不是本地记「提交时刻 + 7 天」：换设备、重新登录、
 * 刷新页面后本地计时都会丢，而服务端时间戳是唯一权威（也是 worker 真正执行去标识化的依据）。
 */
export function coolingOffRemainingDays(purgeScheduledAt: string, nowMs: number): number {
  const due = Date.parse(purgeScheduledAt)
  if (Number.isNaN(due)) return 0
  return Math.max(0, Math.ceil((due - nowMs) / DAY_MS))
}

/** 冷静期倒计时文案。 */
export function coolingOffLabel(purgeScheduledAt: string, nowMs: number): string {
  const days = coolingOffRemainingDays(purgeScheduledAt, nowMs)
  if (days <= 0) return '冷静期已到期，账号即将被注销'
  return `冷静期剩余 ${days} 天`
}

/**
 * 注销流程失败的展示文案。
 *
 * 资格类失败（未完成交易 / 封禁）的 `message` 由服务端给出**具体原因与对方昵称**，
 * 端上原样透出 —— 这是用户唯一能据以行动的信息（去找谁先把交易结掉），
 * 重写成「操作失败」等于把可执行的提示丢掉。
 */
export function describeDeletionFailure(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION') return error.message
    if (error.code === 'ACCOUNT_DELETION_BLOCKED_BANNED') return error.message
    // 冷静期内调用被禁止的写入口（本页理论上只在撤回后才可能遇到，防御性保留）。
    if (error.code === 'ACCOUNT_DELETION_PENDING') {
      return '注销申请处理中，暂不能发布、留言、聊天或交易；你可以先撤回申请'
    }
    if (error.code === 'VALIDATION_FAILED') {
      return `确认词不正确，请逐字输入「${ACCOUNT_DELETION_CONFIRMATION_PHRASE}」`
    }
    if (error.code === 'UNAUTHENTICATED') return '登录状态已失效，请重新登录'
    return error.message
  }
  return fallback
}
