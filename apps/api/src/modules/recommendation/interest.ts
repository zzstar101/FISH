import {
  aggregateInterestVector,
  INTEREST_HALF_LIFE_MS,
  INTEREST_SESSION_MAX_ACTIONS,
  INTEREST_ZERO_WEIGHT_EVENT_TYPES,
  interestLookbackStart,
} from '@fish/contracts/recommendation/interest'
import type { Db } from '@fish/db/client'
import {
  type InterestIdentity,
  type InterestSkipReason,
  loadUserInterestActions,
} from '@fish/db/user-interest-store'

/**
 * **Session 画像**：请求时实时算，不落库（#323 R2 决策）。
 *
 * 为什么 session 与长期画像分成两条链：
 *
 * - session 的定义是"最近几十个行为"，它的正确性取决于**当下**（用户刚连看三件骑行装备就该立刻
 *   偏向骑行），物化到表里必然滞后于写入，还要为每次行为付一次写放大；
 * - 长期画像是 180 天窗口的聚合，每次请求重算的代价随行为量线性增长，只能由 worker 批处理物化。
 *
 * 两者共用同一段纯计算（`aggregateInterestVector`）与同一套"向量是否可用"的判定
 * （`loadUserInterestActions`），差异只有半衰期与条数窗——否则同一批行为在两条路径上会算出不同的
 * 画像，"同输入 + 同 strategyVersion 结果可复现"就不成立。
 *
 * **本函数不接进 `startFeed`**：R1 的 Feed 仍是 `newest` 透传 + `rec-v1-none`，用画像做召回与排序
 * 是 R3/R4 的事。R2 交付的是"能算出 session 画像"这个能力与它的边界（无画像时返回 null），
 * 生产调用方在 R3 落地。
 */

export type SessionInterest = {
  /** L2 归一化后的 session 兴趣向量；`null` = **没有 session 画像**（调用方走冷启动）。 */
  vector: number[] | null
  /** 真正参与聚合的行为条数。 */
  usedActions: number
  /** 窗口内行为因**向量不可用**被跳过的分账（missing / model_mismatch / stale / dimension_mismatch）。 */
  skipped: Record<InterestSkipReason, number>
  /** 因衰减下溢（`< INTEREST_MIN_ACTION_DECAY`）被丢掉的行为条数。 */
  decayedActions: number
}

export type ReadSessionInterestInput = {
  identity: InterestIdentity
  /**
   * 当前 embedding 模型。**由调用方传入**：apps/api 没有 embedding provider 装配
   * （`loadEmbeddingEnv()` 只在 worker 启动期跑），画像读取因此不引入环境依赖，也不会
   * 悄悄用一个"默认模型"去比对向量。
   */
  model: string
  /** 计算基准时刻；显式传入而不是取 `Date.now()`，否则无法复现。 */
  now: Date
}

/**
 * 读某个身份当前的 session 画像。
 *
 * 身份范围（R2 决策）：登录用户与匿名会话**都能**算 session 画像，但**不跨身份合并**——
 * 传 `{kind:'user'}` 只吃带该 `user_id` 的行为，传 `{kind:'anonymous'}` 只吃
 * `anonymous_session_id` 匹配且 `user_id IS NULL` 的行为。长期画像只给登录用户（worker 侧）。
 */
export async function readSessionInterest(
  db: Db,
  input: ReadSessionInterestInput,
): Promise<SessionInterest> {
  const { actions, skipped } = await loadUserInterestActions(db, {
    identity: input.identity,
    model: input.model,
    since: interestLookbackStart(input.now),
    limit: INTEREST_SESSION_MAX_ACTIONS,
    zeroWeightEventTypes: INTEREST_ZERO_WEIGHT_EVENT_TYPES,
  })

  const outcome = aggregateInterestVector({
    actions,
    now: input.now,
    halfLifeMs: INTEREST_HALF_LIFE_MS.session,
  })

  return {
    vector: outcome.vector,
    usedActions: outcome.usedActions,
    skipped,
    decayedActions: outcome.skipped.decayed,
  }
}
