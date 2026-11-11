/**
 * 6 位交易码的**共享口径**（#674）：格式校验 + 后端错误码分派，纯函数、不碰网络。
 *
 * 相机页「输入交易码」浮层（`pkg-vision/pages/scan`）与面交页
 * （`pkg-trade/pages/transaction-meetup`）核销的是同一枚码，服务端也只有一条接口：
 * `POST /transactions/:id/meetup-token/verify-code`（`apps/api/src/modules/transactions/router.ts:234-249`）。
 * 所以**格式校验、后端错误码 → 行内文案**一律取这里，页面里不再各写一份字面量 ——
 * 两处文案一旦分叉，同一笔交易就会出现两种说法。核销链路本身见 `./meetup-verify`。
 */

import type { TransactionDto } from '@fish/contracts/transactions/schema'

/** 交易码位数（与后端 `meetupTokenVerifyCodeInputSchema` 的 6 位一致） */
export const MEETUP_CODE_LEN = 6

/** 只留数字并截到 6 位：整串粘贴、输入法带进来的空格与分隔符都在这里归一。 */
export function normalizeMeetupCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, MEETUP_CODE_LEN)
}

/**
 * 交易码形状：恰好 6 位数字（与后端 `meetupTokenVerifyCodeInputSchema` 的约束一致）。
 * 注意这里**不做归一**——「`12345a6` 剥掉字母后变 6 位」是非法输入，不能当合法码提交
 * （#674 审查 12：早前拿 `normalizeMeetupCode` 的结果判长度，于是混入非数字也能过）。
 */
export function isMeetupCodeShaped(raw: string): boolean {
  return /^\d{6}$/.test(raw)
}

/** 提交前的格式校验：合法返回 `null`，否则给行内文案（位数不足、混入非数字都算错）。 */
export function meetupCodeInputError(raw: string): string | null {
  return isMeetupCodeShaped(raw) ? null : '交易码是 6 位数字，请输满 6 位。'
}

/**
 * 核销失败的三种落点。分派规则与面交页 `verify` 的 catch 完全一致：
 * 终态要重读交易并撤下核销入口、出示方自核销只是「暂不展示」，其余统一进行内文案。
 */
export type MeetupRedeemFailure =
  /** 交易已离开「待面交」（已完成 / 已取消，409 `TRANSACTION_NOT_IN_PENDING`） */
  | { kind: 'terminal' }
  /** 出示方（卖家）不能核销自己出示的码（403 `MEETUP_TOKEN_NOT_ALLOWED`） */
  | { kind: 'not-allowed' }
  /** 码错 / 已用 / 锁定 / 对方未出码 / 兜底：直接展示这句 */
  | { kind: 'message'; message: string }

/** 没有任何错误码可归因（断网、非错误信封）时的兜底，两处共用这一句 */
export const MEETUP_REDEEM_FALLBACK = '核销失败，请检查网络后重试。'

/** 后端错误码 → 行内文案（四类，逐一对齐 router 的 verify-code 错误） */
const REDEEM_MESSAGES: Record<string, string> = {
  MEETUP_TOKEN_INVALID: '交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。',
  MEETUP_TOKEN_CONSUMED: '这个交易码已被使用，不能重复核销。',
  MEETUP_TOKEN_LOCKED:
    '错误次数过多，已临时锁定。请让对方重新打开一次「交易码」页面，再试同一枚码。',
  MEETUP_TOKEN_NOT_FOUND: '对方还没有出示本单的交易码。',
}

/** 核销失败分派（`apiCode === null` = 抛错里没有错误码）。 */
export function meetupRedeemFailure(apiCode: string | null): MeetupRedeemFailure {
  if (apiCode === 'TRANSACTION_NOT_IN_PENDING') return { kind: 'terminal' }
  if (apiCode === 'MEETUP_TOKEN_NOT_ALLOWED') return { kind: 'not-allowed' }
  const message = apiCode === null ? undefined : REDEEM_MESSAGES[apiCode]
  return { kind: 'message', message: message ?? MEETUP_REDEEM_FALLBACK }
}

/* ------------------------------------------------------------------ 核销之后的「确认面交」
 * 交易码被接受（`verify-code` 通过、码已 CONSUMED）只是**第一步**：服务端下一步要求
 * `confirm`（`nextAction: 'CONFIRM_DELIVERY'`）。这一步失败时码已经用掉了，再报
 * 「核销失败」会让用户拿着**已失效的码**重试（只会得到「这个交易码已被使用」），
 * 而正确的出路是「重试确认」。面交页与相机页浮层都要走这个口径，所以判据与文案都放这里。
 */

/** 「码已核销、面交确认还差一步」这句话，两处共用 */
export const MEETUP_CONFIRM_HINT = '交易码已核销成功，面交确认还差最后一步：确认完成本次面交。'

/** 确认入口的按钮文案，两处共用 */
export const MEETUP_CONFIRM_ACTION = '确认完成面交'

/** confirm 阶段失败（网络类、可重试）的提示：**不是**核销失败，不得复用核销兜底文案 */
export const MEETUP_CONFIRM_FAILED = '面交确认没成功，请检查网络后重试。'

/** 核销成功后自动 confirm 失败的处置口径。 */
export type ConfirmFailure = 'terminal' | 'retry'

/**
 * 409 `TRANSACTION_NOT_IN_PENDING` = 核销那一瞬交易已到终态（对方取消 / 另一侧已确认）：
 * 必须重读终态并撤下「还差最后一步确认」（#147 P2）—— 停在待确认会把 CANCELLED 与
 * COMPLETED 两种结果都说错。其余错误（网络等）才回到可重试的确认入口。
 *
 * 只收错误码而不收 `Error`：把 `isApiError` 的判定留在调用点，本模块保持零依赖，
 * 用例不必为了它去 mock `@tarojs/taro`。
 */
export function classifyConfirmFailure(code: string | null): ConfirmFailure {
  return code === 'TRANSACTION_NOT_IN_PENDING' ? 'terminal' : 'retry'
}

/** 一次 confirm 请求的落定结果：成功看交易终态，失败看分类。 */
export type ConfirmOutcome =
  | { kind: 'ok'; status: string }
  | { kind: 'error'; failure: ConfirmFailure }

/**
 * 一次 confirm 落定后，「还差最后一步确认」这个入口的下一帧值（#147 P2）。
 *
 * - 成功：只有交易仍是 `PENDING_MEETUP`（还差另一侧）才保留入口；两个终态一律撤下。
 * - 失败：只有终态冲突才撤下；网络类失败保留入口供重试。
 */
export function nextConfirmPending(outcome: ConfirmOutcome): boolean {
  if (outcome.kind === 'ok') return outcome.status === 'PENDING_MEETUP'
  return outcome.failure === 'retry'
}

/* ------------------------------------------------------- 「码已被用掉」之后该走到哪一屏
 * 核销请求发出去了、响应却没回来（断网 / 杀进程 / 切后台）时，用户再输同一枚码只会拿到
 * 409 `MEETUP_TOKEN_CONSUMED`：码确实用掉了，但页面还停在输码屏，于是除「这个交易码已被
 * 使用」以外没有别的出路（#674 审查 2）。重读交易就能判断该去哪一屏。
 */

/** 「码已被用掉」重读交易后的落点。 */
export type ConsumedCodeVerdict =
  /** 交易已离开待面交：撤下入口，重读终态 */
  | 'terminal'
  /** 本侧已经确认过：核销与确认都完成了 */
  | 'confirmed'
  /** 码用掉了、只差「确认面交」这一步：给重试确认的出口 */
  | 'needs-confirm'

/**
 * 判据只依赖交易本身，不依赖「谁在核销」：服务端 `consumeMeetup` 的检查顺序是
 * 参与者 → 终态 → 非消费方 → 核销（`apps/api/src/modules/transactions/service.ts:300-389`），
 * 所以拿到 `MEETUP_TOKEN_CONSUMED` 时交易**一定还在** `PENDING_MEETUP`；而核销只能由买家发起
 * （卖家拿 403 `MEETUP_TOKEN_NOT_ALLOWED`）、一笔交易只有一枚码且 `issueMeetupToken` 幂等
 * 不轮换，因此「这笔单的码已被用掉」只可能是**自己**上一次核销成功了。
 * 核销那一步盖的是**卖家**的面交确认（`service.ts` 注释：出示码就是他的同意），
 * 所以买家侧还差没差，只看 `buyerConfirmedAt`。
 */
export function consumedCodeVerdict(
  transaction: Pick<TransactionDto, 'status' | 'buyerConfirmedAt'>,
): ConsumedCodeVerdict {
  if (transaction.status !== 'PENDING_MEETUP') return 'terminal'
  return transaction.buyerConfirmedAt === null ? 'needs-confirm' : 'confirmed'
}
