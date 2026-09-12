import type { Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'

/**
 * job 队列的领取与结算（`#2` 冻结的协议见 `packages/db/src/schema/jobs.ts:14-17`）。
 *
 * 抽成模块而不是写在 `index.ts` 里：`index.ts` 有顶层 `await` 与常驻循环，被 import 就会开始跑，
 * 因此那里的逻辑无法被测试。这里的 `runOnce()` 每次都返回一个结构化的结果，测试可以直接断言。
 */

/** 失败重试上限。`jobs` 表没有 `max_attempts`（重试上限是 worker 的策略常量）。 */
export const DEFAULT_MAX_ATTEMPTS = 3

export type ClaimedJob = { id: string; type: string; payload: unknown; attempts: number }

export type RunOutcome = {
  id: string
  type: string
  status: 'DONE' | 'FAILED' | 'PENDING'
  lastError: string | null
  /** handler 的返回值（`DONE` 时），用于日志与测试断言。 */
  result?: unknown
}

/**
 * payload 解码。
 *
 * **必须做这一步**：`db.execute` 的原始结果里 jsonb 是**文本**（驱动不知道列类型），
 * 直接交给 zod 会得到 "expected object, received string"——真实运行时冒烟就是这么炸的。
 *
 * 最多解两层：第一层把 jsonb 文本变成 JS 值，第二层兼容 `packages/db/src/json.ts` 描述过的
 * 「JSON 字符串套 JSON」历史行（那种行的文本外面还包着一层引号）。
 * 解析失败则原样返回，让 schema 校验把它判成坏 payload（→ `FAILED`）。
 */
export function parseJobPayload(raw: unknown): unknown {
  let value = raw
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth += 1) {
    try {
      value = JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

/**
 * bun-sql 的 `execute` 在不同版本下返回数组或 `{ rows }`，两种都接住
 * （与 `apps/api/src/modules/wishes/store.ts:61-67` 同一取舍）。
 */
function toRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

export type JobHandlerTable = Record<string, (payload: unknown) => Promise<unknown>>

export type JobQueue = {
  /** 领取一个待执行 job（`FOR UPDATE SKIP LOCKED`，多 worker 安全）。 */
  claimNext(): Promise<ClaimedJob | null>
  /** 领取并执行一个 job；没有待执行任务时返回 `null`。 */
  runOnce(): Promise<RunOutcome | null>
}

export function createJobQueue(
  db: Db,
  deps: {
    handlers: JobHandlerTable
    maxAttempts?: number
    /** 坏 payload 的错误类型：重试不会变好，直接 FAILED。 */
    isFatalError?: (error: unknown) => boolean
  },
): JobQueue {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  async function claimNext(): Promise<ClaimedJob | null> {
    // 领取与置 RUNNING 在同一条语句里完成，语句提交时行已是 RUNNING，因此不需要额外事务。
    const rows = toRows(
      await db.execute(sql`
        UPDATE jobs
        SET status = 'RUNNING', locked_at = now(), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM jobs
          WHERE status = 'PENDING' AND run_at <= now()
          ORDER BY run_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, type, payload, attempts
      `),
    )

    const row = rows[0]
    if (!row) return null
    return {
      id: String(row.id),
      type: String(row.type),
      payload: parseJobPayload(row.payload),
      attempts: Number(row.attempts ?? 0),
    }
  }

  async function settle(
    id: string,
    status: 'DONE' | 'FAILED' | 'PENDING',
    lastError: string | null,
  ): Promise<void> {
    // 重试不引入退避：`run_at = now()` 让下一次轮询立刻再试（契约 §3.6）。
    await db.execute(sql`
      UPDATE jobs SET status = ${status}, last_error = ${lastError}, run_at = now() WHERE id = ${id}
    `)
  }

  return {
    claimNext,

    async runOnce() {
      const job = await claimNext()
      if (!job) return null

      const handler = deps.handlers[job.type]
      if (!handler) {
        await settle(job.id, 'FAILED', `未知 job 类型：${job.type}`)
        return { id: job.id, type: job.type, status: 'FAILED', lastError: `未知 job 类型` }
      }

      try {
        const result = await handler(job.payload)
        await settle(job.id, 'DONE', null)
        return { id: job.id, type: job.type, status: 'DONE', lastError: null, result }
      } catch (error) {
        const lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        const fatal = (deps.isFatalError?.(error) ?? false) || job.attempts >= maxAttempts
        await settle(job.id, fatal ? 'FAILED' : 'PENDING', lastError)
        return { id: job.id, type: job.type, status: fatal ? 'FAILED' : 'PENDING', lastError }
      }
    },
  }
}
