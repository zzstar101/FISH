import type { SubscribeSendOutcome } from './client'

/**
 * 一次尝试的输入：微信回来的结果，或者**发送之前**就知道不该发的本地判定
 * （收件人没有微信身份 / 该 kind 的模板在发版后又被摘掉）。
 *
 * 后者不并入 `SubscribeSendOutcome`：`client.ts` 只描述上游协议，本地原因不该混进
 * "微信说了什么"这个类型里。
 */
export type AttemptSignal = SubscribeSendOutcome | { ok: false; reason: 'skip'; detail: string }

/**
 * 投递状态机的**纯**决策层（#462）：一次发送结果 → 这条投递行该怎么落。
 *
 * 为什么要单独一个纯函数：状态机是"发了几次微信"这件事的全部真相，而它只在
 * 一个事务里跑（`store.ts` 的 `attemptDelivery`）——那种地方写分支，任何一条
 * 分支错误都只能靠一个真 Postgres 的集成测试发现。把决策抽出来，就可以在单测里
 * 逐条钉住每个 errcode 的结果与重试次数，事务只负责"照抄"结果。
 */

/**
 * 一条投递最多尝试几次（含第一次）。Owner 冻结口径：「重试有限次数」。
 *
 * 为什么是 3：第一次 + 两次退避重试已经覆盖了上游抖动（`-1` 系统繁忙、5xx、
 * 超时）的常见持续时长（30s + 120s），而更长的重试只会让一条早已过时的
 * 「订单已接受」在几分钟后弹出来 —— 迟到的订阅消息比不发的伤害更大。
 */
export const MAX_SEND_ATTEMPTS = 3

/**
 * 第 N 次失败后的退避间隔（毫秒）：`RETRY_DELAYS_MS[0]` 用于第 1 次失败，
 * `RETRY_DELAYS_MS[1]` 用于第 2 次失败。取完即用最后一档（本进程里走不到，
 * 因为 `MAX_SEND_ATTEMPTS` 已经把第 3 次失败直接判成 FAILED）。
 *
 * 与 `access-token.ts` 的 `ACCESS_TOKEN_FAILURE_BACKOFF_MS` 同一理由：指数退避挡住的是
 * "上游故障期间每个 tick 都再打一次微信"，而不是省那几次调用。
 */
const FIRST_RETRY_DELAY_MS = 30_000
const RETRY_DELAYS_MS = [FIRST_RETRY_DELAY_MS, 120_000] as const

/** 一次尝试之后这条投递行的去向。`error` 是**脱敏**短串，直接可落 `last_error` / 打日志。 */
export type DeliveryTransition =
  | { status: 'SENT' }
  /** `clearGrant`：微信说「用户拒绝 / 没有次数」（43101），本地计数与上游已经对不上，置 0。 */
  | { status: 'SKIPPED'; error: string; clearGrant: boolean }
  | { status: 'FAILED'; error: string; errcode: number | null }
  | { status: 'RETRY'; error: string; errcode: number | null; nextAttemptInMs: number }

/** 已经尝试过 `committedAttempts` 次之后（含这一次）的退避时长。 */
export function retryDelayMs(committedAttempts: number): number {
  const index = Math.min(Math.max(committedAttempts, 1), RETRY_DELAYS_MS.length) - 1
  // 越界（理论上不可达，见上面的注释）退到第一档，而不是 `undefined` ——
  // 退避时长若是 NaN，`next_attempt_at` 会被写成 Invalid Date。
  return RETRY_DELAYS_MS[index] ?? FIRST_RETRY_DELAY_MS
}

/**
 * 一次发送的结果 + 这次尝试的序号 → 该行的新状态。
 *
 * `committedAttempts` 是**含本次**的尝试次数（库里 `attempts` 存的是已完成次数，
 * 调用方先 +1 再调本函数），所以「最多 3 次」在这里读作 `>= MAX_SEND_ATTEMPTS` 即放弃。
 *
 * 各分支的依据（`client.ts` 已完成 errcode → `reason` 的归类，这里只管后果）：
 * - `no-quota`（43101）：用户拒绝或次数用完 —— 不是故障。该 kind 本地计数置 0，
 *   行判 SKIPPED，**不重试**（再试只会拿同一个 43101）。
 * - `skip`（`no_openid` / `no_template`）：发之前就知道发不出去，行判 SKIPPED，不扣额度、不重试。
 * - `permanent`（40003 / 40037 / 41030 / 47003）：参数或模板问题，重试无意义 → FAILED。
 * - `retryable`（超时 / 网络 / 5xx / -1 / 凭证类）：退避后重试，超次数才 FAILED。
 */
export function planAttempt(outcome: AttemptSignal, committedAttempts: number): DeliveryTransition {
  if (outcome.ok) return { status: 'SENT' }

  // 本地判定：不是一次尝试，也不该扣额度、更不该重试。
  if (outcome.reason === 'skip') {
    return { status: 'SKIPPED', error: outcome.detail, clearGrant: false }
  }

  if (outcome.reason === 'no-quota') {
    return { status: 'SKIPPED', error: outcome.detail, clearGrant: true }
  }

  if (outcome.reason === 'permanent') {
    return { status: 'FAILED', error: outcome.detail, errcode: outcome.errcode }
  }

  if (committedAttempts >= MAX_SEND_ATTEMPTS) {
    return { status: 'FAILED', error: outcome.detail, errcode: outcome.errcode ?? null }
  }

  return {
    status: 'RETRY',
    error: outcome.detail,
    errcode: outcome.errcode ?? null,
    nextAttemptInMs: retryDelayMs(committedAttempts),
  }
}
