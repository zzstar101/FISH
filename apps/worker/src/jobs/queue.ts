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

/** `recoverStaleClaims()` 写进 `last_error` 的原因，用来和业务失败区分开。 */
export const STALE_CLAIM_ERROR = 'worker restarted while running'

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

/** `recoverStaleClaims()` 的返回值：两类僵死行的条数（启动日志与测试断言都用它）。 */
export type RecoveredClaims = {
  /** 回到 `PENDING`、会被重新领取的条数。 */
  requeued: number
  /** `attempts` 已达上限、直接置 `FAILED` 的条数。 */
  failed: number
}

export type JobQueue = {
  /**
   * 领取一个待执行 job（`FOR UPDATE SKIP LOCKED`，多 worker 不会领到同一行）。
   *
   * ⚠️ 但**启动回收**（`recoverStaleClaims`）不判 `locked_at` 时限，所以“多 worker 安全”只在
   * 领取这一步成立：同一数据库同时只能跑**一个** worker 进程（含另一个终端的 `dev:worker`
   * 与集成测试），否则互相抢活。
   */
  claimNext(): Promise<ClaimedJob | null>
  /** 领取并执行一个 job；没有待执行任务时返回 `null`。 */
  runOnce(): Promise<RunOutcome | null>
  /** 回收僵死领取（`RUNNING` 行分流）。**只在 worker 启动时调用一次。** */
  recoverStaleClaims(): Promise<RecoveredClaims>
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
    // `locked_at` 必须清空：它表示"正被某个 worker 持有"，结算后这行已经不再被持有；
    // 留着会让僵死行的判读（以及任何按 locked_at 的观测）失真。
    // raw SQL 绕过 drizzle 的 `$onUpdate`，所以 `updated_at` 必须自己写，否则这一行的
    // `updated_at` 会停在“被领取前”（与 `schema/common.ts` 的“app 侧维护”约定不一致）。
    await db.execute(sql`
      UPDATE jobs
      SET status = ${status}, last_error = ${lastError}, run_at = now(), locked_at = NULL,
          updated_at = now()
      WHERE id = ${id}
    `)
  }

  /**
   * 僵死领取的回收（#43 的"Worker 重启后未完成 job 可继续"）。
   *
   * `claimNext` 把"领取"与"置 RUNNING"写在同一条 UPDATE 里，所以进程在 handler 执行期间
   * 被 `kill -9` 时那行会永远停在 `RUNNING`：没有任何查询会再碰它，`last_error` 也是空的。
   *
   * **只在启动时回收，且不判 `locked_at` 时限**：这要求**同一数据库同时只跑一个 worker 进程**
   * （含另一个终端的 `dev:worker` 与集成测试）。启动时看到的 `RUNNING` 必然属于已经死掉的进程，
   * 无条件重置是正确且不需调参的；但若第二个进程启动时第一个还在跑，它会连对方正在执行的 job
   * 一起翻回 `PENDING`，同一 job 就被执行两次。真要支持多副本，必须换成 `locked_at` + 续租的
   * lease 语义（`jobs_running_locked_at_idx` 就是为那种查询准备的）。
   *
   * `attempts` 已达上限的行不再回 `PENDING`：重试不会变好，回队列等于无限重试。
   *
   * 两个分支对 `last_error` 的口径刻意不同：回 `PENDING` 时**保留**上一次的失败原因（下一次尝试失败
   * 时 `settle()` 会覆盖它，而排掉了旧的反而丢掉了“为什么第 1 次失败”的证据）；置 `FAILED` 时**改写**成
   * 本次回收的原因，因为那个原因才是该行终态的原因。两个分支都必须清 `locked_at`——行已经不被任何
   * worker 持有（与 `settle()` 同一不变式）。
   */
  async function recoverStaleClaims(): Promise<RecoveredClaims> {
    // 两条 UPDATE 放在同一事务里：否则第一条提交后、第二条执行前被别的领取者改成 RUNNING 的行
    // 会被第二条按 `attempts >= max` 误判成 FAILED。
    // 两条的谓词在同快照下不重叠：第一条带走 `attempts < max` 的 RUNNING 行，第二条只剩 `attempts >= max` 的。
    // raw SQL 绕过 `$onUpdate`，所以 `updated_at` 自己写（否则被回收过的行看不出被回收过）。
    return db.transaction(async (tx) => {
      const requeued = toRows(
        await tx.execute(sql`
          UPDATE jobs
          SET status = 'PENDING', run_at = now(), locked_at = NULL, updated_at = now()
          WHERE status = 'RUNNING' AND attempts < ${maxAttempts}
          RETURNING id
        `),
      )
      const failed = toRows(
        await tx.execute(sql`
          UPDATE jobs
          SET status = 'FAILED', last_error = ${STALE_CLAIM_ERROR}, run_at = now(),
              locked_at = NULL, updated_at = now()
          WHERE status = 'RUNNING' AND attempts >= ${maxAttempts}
          RETURNING id
        `),
      )

      return { requeued: requeued.length, failed: failed.length }
    })
  }

  return {
    claimNext,
    recoverStaleClaims,

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
