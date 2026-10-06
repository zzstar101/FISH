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
