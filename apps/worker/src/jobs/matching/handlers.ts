import {
  MATCH_JOB_TYPES,
  MatchListingJobPayloadSchema,
  MatchWishJobPayloadSchema,
} from '@fish/contracts/matching/jobs'
import type { Db } from '@fish/db/client'
import { InvalidJobPayloadError } from '../invalid-payload-error'
import { createMatchEngine, type MatchEngineOptions, type MatchRunResult } from './engine'

/**
 * job → handler 的入口（Issue #8 契约评论 §3.5 / §3.7）。
 *
 * handler 接收**未校验的 payload**并自己校验：worker 的队列层不需要知道任何 domain 的 payload 形状，
 * 而"坏 payload"（多余字段 / 缺字段 / 类型不符）与"运行失败"必须区分——前者重试不会变好，
 * 应当直接 `FAILED`（见 `InvalidJobPayloadError`）。
 */

/** 保持既有导入路径可用；类本体已提到 job 层共用（`../invalid-payload-error`）。 */
export { InvalidJobPayloadError }

/**
 * 匹配域的 job handler 表。
 *
 * 键用 `MATCH_JOB_TYPES` 而不是字面量：`packages/db` 也有一份 `JobType` 联合
 * （`packages/db/src/schema/jobs.ts:8`，它不能依赖 contracts），所以这个对象是那份联合的
 * 单点消费处——加新 job 类型时两处一起改（契约评论 §6.3）。
 */
export type MatchJobHandlers = {
  [MATCH_JOB_TYPES.listing]: (payload: unknown) => Promise<MatchRunResult>
  [MATCH_JOB_TYPES.wish]: (payload: unknown) => Promise<MatchRunResult>
}

export function createMatchJobHandlers(db: Db, options: MatchEngineOptions): MatchJobHandlers {
  const engine = createMatchEngine(db, options)

  return {
    [MATCH_JOB_TYPES.listing]: async (payload) => {
      const parsed = MatchListingJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(MATCH_JOB_TYPES.listing, parsed.error.message)
      }
      return engine.matchListing(parsed.data.listingId)
    },

    [MATCH_JOB_TYPES.wish]: async (payload) => {
      const parsed = MatchWishJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(MATCH_JOB_TYPES.wish, parsed.error.message)
      }
      return engine.matchWish(parsed.data.wishId)
    },
  }
}
