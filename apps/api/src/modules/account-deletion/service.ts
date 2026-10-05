import {
  ACCOUNT_DELETION_COOLING_OFF_DAYS,
  type AccountDeletionErrorCode,
  type AccountDeletionRequestResponse,
  type AccountDeletionStatus,
} from '@fish/contracts/account-deletion/schema'
import { hashSessionToken } from '../auth/session'
import type { ConnectionHub } from '../realtime/hub'
import type { AccountDeletionStore, BlockingTransactions, RequestDeletionOutcome } from './store'

/**
 * 账号注销的业务编排（Issue #464）。SQL 全在 `store.ts`，HTTP 全在 `router.ts`，
 * 这里只做三件事：算冷静期、把 store 的判定结果翻成错误 / 响应、断开 WS。
 *
 * ## 资格校验为什么没有「先查一遍」的快速路径
 *
 * 冻结口径的两条硬阻塞都必须在**事务内、拿到账号行锁之后**判定（理由见 `store.ts` 文件头），
 * 所以 service 不预先查一次 —— 那只会多一次库往返，而且给出一个「查的时候没阻塞、写的时候
 * 阻塞」的假象。所有判定结果都由 `store.requestDeletion` 一次性回报。
 */

/** 冷静期内 / 封禁中等业务失败。状态码与错误码的映射只在这里出现一次（与 `AuthError` 同构）。 */
export class AccountDeletionError extends Error {
  constructor(
    readonly code: AccountDeletionErrorCode,
    readonly status: 403 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'AccountDeletionError'
  }
}

/**
 * 竞态兜底（对抗性审查 m1）：`requireAuth` 放行之后、账号行锁拿到之前，worker 把账号去标识化了。
 * 此时身份已不存在，正确语义是 401 重新登录 —— 不是 500，也不是一个臆造的注销状态。
 */
export class AccountDeletedRaceError extends Error {
  constructor() {
    super('账号已注销，请重新登录')
    this.name = 'AccountDeletedRaceError'
  }
}

/** 7 天冷静期的毫秒数。天数取自契约（端上算倒计时读的是同一个常量）。 */
const COOLING_OFF_MS = ACCOUNT_DELETION_COOLING_OFF_DAYS * 24 * 60 * 60 * 1000

/**
 * 把「有未完成交易」翻成用户能据此行动的一句话：几笔、对方是谁。
 *
 * 信封没有结构化字段放它（`details` 是字段级校验错误），所以写进 `message`。只报至多
 * `BLOCKING_TRANSACTION_SAMPLE_LIMIT` 个昵称（去重），总数另计 —— 冻结口径要求「回报具体
 * 原因与对方」，但没有要求把几十个昵称塞进一句提示。
 */
function blockingMessage(blocking: BlockingTransactions): string {
  const names = [
    ...new Set(
      blocking.samples
        .map((sample) => sample.counterpartyNickname)
        .filter((nickname): nickname is string => nickname !== null && nickname.length > 0),
    ),
  ]
  const who = names.length > 0 ? `（对方：${names.join('、')}）` : ''
  return `存在 ${blocking.total} 笔未完成交易${who}，需先完成或取消后再申请注销`
}

export function createAccountDeletionService(deps: {
  store: AccountDeletionStore
  /**
   * 断开该用户 WS 的能力（#464 Q14）。可选依赖：测试与不关心实时的装配可以不传，
   * 此时只是「会话已撤销但连接还挂着」——推送本身不会泄漏写权限（写被 requireAuth 拦掉）。
   */
  hub?: Pick<ConnectionHub, 'closeUser'>
  /** 可注入时钟（测试固定 7 天边界用）。 */
  now?: () => Date
}) {
  const now = deps.now ?? (() => new Date())

  return {
    /** `GET /me/account-deletion`：任何登录态（含冷静期内）都可读。 */
    async status(userId: string): Promise<AccountDeletionStatus> {
      const status = await deps.store.loadStatus(userId)
      if (!status) {
        // 不可达：`requireAuth` 刚用同一个 id 读过 users 行，而本仓库没有任何路径物理删除
        // users（历史引用全是 restrict / cascade 到别的表）。抛错失败关闭，不臆造一个状态。
        throw new Error(`账号注销：读不到账号状态（user=${userId}）`)
      }
      return status
    },

    /** `POST /me/account-deletion`：申请注销。幂等，不重置冷静期。 */
    async request(
      userId: string,
      input: { sessionToken: string | undefined },
    ): Promise<AccountDeletionRequestResponse> {
      const at = now()
      const outcome: RequestDeletionOutcome = await deps.store.requestDeletion({
        userId,
        now: at,
        purgeScheduledAt: new Date(at.getTime() + COOLING_OFF_MS),
        // 保留当前设备：requireAuth 保证了请求带着有效会话，拿不到令牌只是防御性退化
        // （此时撤销全部会话，用户下次请求会 401 并重新登录 —— 失败关闭方向是对的）。
        keepTokenHash: input.sessionToken ? hashSessionToken(input.sessionToken) : null,
      })

      switch (outcome.kind) {
        case 'blocked-banned':
          throw new AccountDeletionError(
            'ACCOUNT_DELETION_BLOCKED_BANNED',
            403,
            '账号处于封禁中，不能申请注销；请先申诉解除封禁',
          )
        case 'blocked-pending-transaction':
          throw new AccountDeletionError(
            'ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION',
            409,
            blockingMessage(outcome.blocking),
          )
        case 'already-requested':
          // 幂等命中：没有下架动作发生，所以计数是 0（不是「上次下架了几件」）。
          return { ...outcome.status, offlinedListingCount: 0 }
        case 'gone':
          throw new AccountDeletedRaceError()
        case 'requested': {
          // 断开该用户**全部**连接（含当前设备）：其他设备的会话已被撤销，它们的重连会在
          // upgrade 阶段被 401 拦掉；当前设备的连接也一起断，客户端重连后照常可用。
          deps.hub?.closeUser(userId)
          return { ...outcome.status, offlinedListingCount: outcome.offlinedListingCount }
        }
      }
    },

    /** `DELETE /me/account-deletion`：撤回申请。幂等，**不恢复**已下架的商品。 */
    async withdraw(userId: string): Promise<AccountDeletionStatus> {
      const outcome = await deps.store.withdrawDeletion({ userId, now: now() })
      if (outcome.kind === 'gone') throw new AccountDeletedRaceError()
      return outcome.status
    },
  }
}

export type AccountDeletionService = ReturnType<typeof createAccountDeletionService>
