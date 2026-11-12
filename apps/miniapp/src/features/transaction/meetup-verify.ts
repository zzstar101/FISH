/**
 * 核销链路（#674）：`verify-code` / `redeem` → 按响应 `nextAction` 收尾。
 *
 * 两个核销入口共用这里：相机页「输入交易码」浮层调 `consumeMeetupCode`；面交页因为要和
 * 代次锁、核验动效、confirm 失败重试交织，自己保留外层流程，但「拿到响应之后做什么」一律
 * 走 `finishMeetupVerification` —— `nextAction` 只在这一处被解释，页面里不再各串一遍
 * `verify() → confirmTransaction()`（#674 审查 13）。
 *
 * 与 `./meetup-code` 分开：那边是纯函数（单测直接 import），这边要碰网络客户端。
 */
import type {
  MeetupVerificationResponse,
  TransactionDto,
} from '@fish/contracts/transactions/schema'
import { isApiError } from '@/lib/request'
import { confirmTransaction, fetchTransaction, verifyMeetupCode } from './api'
import { consumedCodeVerdict } from './meetup-code'

/**
 * 核销成功后的 `nextAction` → 收尾动作。契约目前只有 `CONFIRM_DELIVERY`（确认面交，幂等）。
 * 用 `Record` 而不是 `if`：契约加值时编译期就会拦住，不会静默少做一步。
 */
const AFTER_VERIFY: Record<
  MeetupVerificationResponse['nextAction'],
  (transactionId: string) => Promise<TransactionDto>
> = {
  CONFIRM_DELIVERY: (transactionId) => confirmTransaction(transactionId),
}

/**
 * 核销成功（码已被接受）之后按 `nextAction` 收尾，返回收尾后的交易。
 * 调用点只负责把这里的失败归入「确认面交没成」，不要重新解释 `nextAction`。
 */
export async function finishMeetupVerification(
  transactionId: string,
  verified: MeetupVerificationResponse,
): Promise<TransactionDto> {
  return AFTER_VERIFY[verified.nextAction](transactionId)
}

/**
 * 一次核销的分阶段结果。
 *
 * 为什么要分阶段：`verify-code` 通过那一刻**码就已经用掉了**（服务端置 CONSUMED），后面
 * `confirm` 失败再笼统报「核销失败」，用户拿着这枚已失效的码重试只会得到
 * 「这个交易码已被使用」。所以 confirm 阶段失败必须作为**数据**返回，让调用点给出
 * 「重试确认」的出口，而不是混进核销错误里（审查 P1）。
 *
 * `verify` 阶段的失败仍按原样抛错：那是真的没核销成功，错误码由调用点用
 * `./meetup-code` 的 `meetupRedeemFailure` 分派。唯一的例外是「码早前已被用掉」，
 * 那不是失败而是**要接着走确认**，所以也作为数据返回（审查 2）。
 */
export type MeetupConsumeResult =
  /** 码被接受且 `nextAction` 已收尾成功：拿到收尾后的交易（已可判终态） */
  | { kind: 'confirmed'; transaction: TransactionDto }
  /** 码已核销，但收尾的 confirm 失败：`apiCode` 交给 `classifyConfirmFailure` 分派 */
  | { kind: 'confirm-failed'; apiCode: string | null }
  /** 码早前已被本单用掉、交易仍在待面交且本侧未确认：还差「确认面交」，给重试出口 */
  | { kind: 'needs-confirm'; transaction: TransactionDto }

/**
 * 码已被用掉（409 `MEETUP_TOKEN_CONSUMED`）时，重读交易判断该去哪一步。
 * 判据见 `./meetup-code` 的 `consumedCodeVerdict`：CONSUMED 只可能出现在待面交、且只可能
 * 是自己上一次核销成功但响应丢了，所以这里恢复的是「确认」而不是错误提示。
 */
async function recoverConsumedCode(transactionId: string): Promise<MeetupConsumeResult> {
  const transaction = await fetchTransaction(transactionId)
  switch (consumedCodeVerdict(transaction)) {
    case 'confirmed':
      return { kind: 'confirmed', transaction }
    case 'needs-confirm':
      return { kind: 'needs-confirm', transaction }
    case 'terminal':
      // 与「核销时交易已到终态」同一落点：调用点会重读并撤下入口
      return { kind: 'confirm-failed', apiCode: 'TRANSACTION_NOT_IN_PENDING' }
  }
}

/** 核销一枚 6 位交易码，并按 `nextAction` 收尾；返回分阶段结果。 */
export async function consumeMeetupCode(
  transactionId: string,
  code: string,
): Promise<MeetupConsumeResult> {
  let verified: MeetupVerificationResponse
  try {
    verified = await verifyMeetupCode(transactionId, code)
  } catch (error) {
    // 码用掉了不等于这次输入无效：响应丢失 / 确认没走完时，重输只会永远拿 CONSUMED
    if (isApiError(error) && error.code === 'MEETUP_TOKEN_CONSUMED') {
      return recoverConsumedCode(transactionId)
    }
    throw error
  }
  try {
    const transaction = await finishMeetupVerification(transactionId, verified)
    return { kind: 'confirmed', transaction }
  } catch (error) {
    // 走到这里码一定已经 CONSUMED：这是「确认面交」那一步没成，不是核销失败
    return { kind: 'confirm-failed', apiCode: isApiError(error) ? error.code : null }
  }
}
