import {
  aggregateInterestVector,
  INTEREST_HALF_LIFE_MS,
  INTEREST_STRATEGY_VERSION,
  INTEREST_ZERO_WEIGHT_EVENT_TYPES,
  interestLookbackStart,
} from '@fish/contracts/recommendation/interest'
import {
  RECOMMENDATION_JOB_TYPES,
  RefreshUserInterestJobPayloadSchema,
} from '@fish/contracts/recommendation/jobs'
import type { Db } from '@fish/db/client'
import {
  deleteUserInterestProfile,
  findUserInterestProfile,
  loadUserInterestActions,
  saveUserInterestProfile,
} from '@fish/db/user-interest-store'
import { InvalidJobPayloadError } from '../invalid-payload-error'

/**
 * **长期画像**重算 handler（#323 R2）。
 *
 * 一次运行 = "读该用户近 180 天的行为 → 逐条判定向量可用性 → 加权聚合 → 覆盖式写画像行"。
 * 五个关键点：
 *
 * 1. **payload 只带 `userId`，数据全部在运行时读**：所以晚到的旧 job 只会用当前数据算，
 *    "从 0 全量重算"天然幂等可重放——重算结果由数据决定，不由入队时刻决定。
 * 2. **不做增量累加**：画像行是"当前数据算出来的画像"，不是行为账本。少了这一步，
 *    事件被 retention 清理、商品被删、向量换模型重建之后，画像会永远留着一份证据已不存在的加权和。
 * 3. **窗口内没有可用向量就删掉旧行**（而不是写零向量）：读取侧返回 `null`、R3 走冷启动，
 *    才是诚实的降级；零向量与所有商品 cosine 距离相同，会把"没有画像"伪装成"有画像"。
 * 4. **写入与删除都带 CAS**（`computed_at >= computed_at`）：并发的两次重算谁最后生效不由执行顺序决定，
 *    而是由**读完行为数据那一刻**的版本号决定，旧数据算出来的结果不会覆盖（也不会删掉）新数据算出来的结果。
 *    `superseded` 不是错误：说明有更晚的一次重算已经把更新的结果写进去了，job 照常 DONE。
 *    ⚠️ 版本号必须在**读返回之后**取（见下方 `clock`）：取在函数入口会让"晚开始、晚读到、晚算完"
 *    的 job 拿到比它读到的数据更旧的版本号，被更早开始却读到更旧数据的 job 挡成 `superseded`——
 *    库里因此停在一份证据更旧的画像上，直到用户下一条行为才被纠正。
 * 5. **只处理登录用户**：`REFRESH_USER_INTEREST` 由 api 端在**登录用户**的行为落库后投递
 *    （`apps/api/src/modules/recommendation/interest-queue.ts`），匿名会话只有 session 画像。
 */

/** 一次画像重算的结果，会作为 job 的 `result` 记入日志与测试断言。 */
export type RefreshUserInterestRunResult = {
  userId: string
  /**
   * `saved` 已写入画像；`superseded` 被更晚的一次重算抢先（写入或删除被 CAS 挡住）；`cleared`
   * 窗口内已无可用向量并删掉了旧行；`empty` 窗口内无可用向量且本来就没有画像行。
   */
  status: 'saved' | 'superseded' | 'cleared' | 'empty'
  /** 真正参与聚合的行为条数。 */
  usedActions: number
  /** 被跳过的行为按原因分账（无可用向量 / 衰减下溢）。 */
  skipped: { noVector: number; decayed: number }
}

export type InterestJobHandlers = {
  [RECOMMENDATION_JOB_TYPES.refreshUserInterest]: (
    payload: unknown,
  ) => Promise<RefreshUserInterestRunResult>
}

/**
 * 全量重算某个用户的长期画像。
 *
 * `computedAt` 取的是**读完行为数据那一刻**（既不是函数入口，也不是算完之后）：
 * 两次并发重算各自读到不同时刻的数据时，谁新谁旧由"读完"这个时刻决定。
 * 取在函数入口（旧写法）会让一个入口早、却晚才真正读到数据的 job 拿到更旧的版本号，被挡成
 * `superseded`；取"算完之后"则会让一个读得早、算得慢的 job 拿到更晚的版本号，反而覆盖掉
 * 更新数据算出来的画像。两端都不能要，只有读返回这一瞬间反映数据快照的新旧。
 */
export async function refreshUserInterestProfile(
  db: Db,
  input: {
    userId: string
    embeddingModel: string
    /** 衰减与窗口的时间基准（测试注入用）。 */
    now?: Date
    /**
     * 版本号时钟：**读完行为数据之后**才调用一次（默认 `() => new Date()`）。
     * 单独留一个注入口，是为了让测试能把"入口时刻"与"读完时刻"分开构造。
     */
    clock?: (() => Date) | undefined
  },
): Promise<RefreshUserInterestRunResult> {
  const now = input.now ?? new Date()
  const since = interestLookbackStart(now)

  const { actions, skipped } = await loadUserInterestActions(db, {
    identity: { kind: 'user', id: input.userId },
    model: input.embeddingModel,
    since,
    zeroWeightEventTypes: INTEREST_ZERO_WEIGHT_EVENT_TYPES,
  })

  // 版本号：数据已经读完了（`loadUserInterestActions` 已 resolve），此刻才是这次计算的"数据快照版本"。
  // `now` 注入时默认沿用它，保持既有用例的确定性；生产路径（不注入）取的就是真实读完时刻。
  const computedAt = (input.clock ?? (() => input.now ?? new Date()))()

  const outcome = aggregateInterestVector({
    actions,
    now,
    halfLifeMs: INTEREST_HALF_LIFE_MS.longTerm,
  })

  const vector = outcome.vector
  // `loadUserInterestActions` 按四种原因分账（missing / model_mismatch / stale / dimension_mismatch），
  // job 结果只需要"有多少条行为的向量不可用"这一个总数（细分原因留给 R6 的可观测性）。
  const noVector =
    skipped.missing + skipped.model_mismatch + skipped.stale + skipped.dimension_mismatch
  const result = {
    userId: input.userId,
    usedActions: outcome.usedActions,
    skipped: { noVector, decayed: outcome.skipped.decayed },
  }

  if (vector === null) {
    // 没有可用行为 → 该用户**现在**没有画像。旧行必须删掉（理由见文件头 §3），
    // 但删除同样受 `computed_at` 的 CAS 约束（§4）：只删不比本次计算更新的行。
    const deleted = await deleteUserInterestProfile(db, {
      userId: input.userId,
      model: input.embeddingModel,
      computedAt,
    })
    if (deleted > 0) {
      return { ...result, status: 'cleared' }
    }
    // 0 行：要么本来就没有画像行，要么库里那份比本次计算更新（CAS 挡下）。两者语义不同，
    // 前者是 `empty`，后者是 `superseded`——读一次才能分开，也让"有更晚写入"在日志里可见。
    const existing = await findUserInterestProfile(db, {
      userId: input.userId,
      model: input.embeddingModel,
    })
    return { ...result, status: existing === null ? 'empty' : 'superseded' }
  }

  const written = await saveUserInterestProfile(db, {
    userId: input.userId,
    model: input.embeddingModel,
    dimensions: vector.length,
    strategyVersion: INTEREST_STRATEGY_VERSION,
    embedding: vector,
    actionCount: outcome.usedActions,
    windowStartedAt: since,
    computedAt,
  })

  return { ...result, status: written ? 'saved' : 'superseded' }
}

export function createInterestJobHandlers(
  db: Db,
  options: { embeddingModel: string },
): InterestJobHandlers {
  return {
    [RECOMMENDATION_JOB_TYPES.refreshUserInterest]: async (payload) => {
      const parsed = RefreshUserInterestJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(
          RECOMMENDATION_JOB_TYPES.refreshUserInterest,
          parsed.error.message,
        )
      }

      return refreshUserInterestProfile(db, {
        userId: parsed.data.userId,
        embeddingModel: options.embeddingModel,
      })
    },
  }
}
