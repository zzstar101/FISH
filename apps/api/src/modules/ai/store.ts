import type { Db } from '@fish/db/client'
import { type AiPolishOutcome, aiPolishRequests } from '@fish/db/schema/ai-polish-requests'
import { eq, sql } from 'drizzle-orm'

/**
 * 配额（#141 设计 §5.2）。常量一律不进 env（§3.3）：可配项越多，stub 与 live 的行为差异越难对齐。
 */
export const AI_POLISH_MIN_INTERVAL_SECONDS = 5
export const AI_POLISH_DAILY_LIMIT = 30
export const AI_POLISH_WINDOW_HOURS = 24

export type ReserveResult =
  | { allowed: true; requestId: string }
  | { allowed: false; retryAfterSeconds: number }

export type AiPolishStore = {
  /**
   * 配额检查 + 写占位行，**自带事务**：先取事务级 advisory lock 串行化"先查后插"——READ
   * COMMITTED 下并发事务都会读到旧的计数，仅靠事务拦不住并发突破额度（同 `verification-service`
   * 的写法）。通过检查后立即写占位行："上游失败也扣配额"由这一步保证（设计 §5.2）。
   *
   * 事务边界收在这里而不是 service：上游调用最长 8s，事务绝不能跨上游开着；service 因此不持有
   * db，整条流水线可以用假 store 单测。
   */
  reserve(input: {
    userId: string
    inputChars: number
    model: string
    promptVersion: string
  }): Promise<ReserveResult>
  /** 回写出口与指标。 */
  finish(input: {
    requestId: string
    outcome: AiPolishOutcome
    candidateCount: number
    filteredCount: number
    latencyMs: number
    promptTokens?: number
    completionTokens?: number
  }): Promise<void>
}

export function createSqlAiPolishStore(db: Db): AiPolishStore {
  return {
    async reserve(input) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`ai-polish:${input.userId}`}))`,
        )

        // 时间比较全部用 DB 时钟 now()：应用时钟与库时钟不一致时，配额窗口会算错。
        // `outcome is distinct from 'EMPTY'` 而不是 `<> 'EMPTY'`：占位行先落库、outcome 还是
        // NULL，用 `<>` 会把"还没回写"的行排除在计数外——崩一次就等于白送一次额度。
        // `EMPTY` 不计（上游正常返回但候选全被过滤，对用户无损，设计 §5.2）；被拒请求不写行，
        // 否则会把 COUNT 撑大、形成"拒一次就少一次额度"的自我收紧。
        const rows = await tx.execute<{
          interval_wait_seconds: number
          daily_wait_seconds: number
        }>(sql`
          select
            coalesce((
              select ceil(extract(epoch from (
                       make_interval(secs => ${AI_POLISH_MIN_INTERVAL_SECONDS}) - (now() - max(created_at))
                     )))::int
                from ai_polish_requests
               where user_id = ${input.userId}
                 and outcome is distinct from 'EMPTY'
              having max(created_at) is not null
                 and now() - max(created_at) < make_interval(secs => ${AI_POLISH_MIN_INTERVAL_SECONDS})
            ), 0) as interval_wait_seconds,
            coalesce((
              select ceil(extract(epoch from (
                       (min(created_at) + make_interval(hours => ${AI_POLISH_WINDOW_HOURS})) - now()
                     )))::int
                from ai_polish_requests
               where user_id = ${input.userId}
                 and created_at > now() - make_interval(hours => ${AI_POLISH_WINDOW_HOURS})
                 and outcome is distinct from 'EMPTY'
              having count(*) >= ${AI_POLISH_DAILY_LIMIT}
            ), 0) as daily_wait_seconds
        `)

        const row = rows[0]
        const retryAfterSeconds = Math.max(
          Number(row?.interval_wait_seconds ?? 0),
          Number(row?.daily_wait_seconds ?? 0),
        )
        if (retryAfterSeconds > 0) return { allowed: false, retryAfterSeconds }

        const inserted = await tx
          .insert(aiPolishRequests)
          .values({
            userId: input.userId,
            inputChars: input.inputChars,
            model: input.model,
            promptVersion: input.promptVersion,
          })
          .returning({ id: aiPolishRequests.id })

        const requestId = inserted[0]?.id
        if (!requestId) throw new Error('AI 润色占位行写入失败：insert ... returning 未返回行')

        return { allowed: true, requestId }
      })
    },

    async finish(input) {
      await db
        .update(aiPolishRequests)
        .set({
          outcome: input.outcome,
          candidateCount: input.candidateCount,
          filteredCount: input.filteredCount,
          latencyMs: input.latencyMs,
          ...(input.promptTokens === undefined ? {} : { promptTokens: input.promptTokens }),
          ...(input.completionTokens === undefined
            ? {}
            : { completionTokens: input.completionTokens }),
        })
        .where(eq(aiPolishRequests.id, input.requestId))
    },
  }
}
