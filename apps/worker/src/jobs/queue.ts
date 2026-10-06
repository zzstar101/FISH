import type { Db } from '@fish/db/client'
import type { JobType } from '@fish/db/schema/jobs'
import { type SQL, sql } from 'drizzle-orm'
import { errorMessage } from '../log'

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

/**
 * 让位原因：同实体已经有一条 `PENDING` 行在排队，这条行再回到 `PENDING` 会撞 partial unique
 * index（23505）。它的重算由那条 `PENDING` 覆盖，所以这条行直接终态化成 `FAILED`。
 *
 * 与 `STALE_CLAIM_ERROR` 分开：那个说明"进程死了"，这个说明"这条行已经没有必要再跑一次"。
 * 写进 `last_error` 时后面会拼上这行上一次的失败原因（见 `supersededReason()`）。
 */
export const SUPERSEDED_BY_PENDING_ERROR = 'superseded by a pending job for the same entity'

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
export function toRows(result: unknown): Record<string, unknown>[] {
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
  /**
   * 被回收直接置 `FAILED` 的条数：`attempts` 已达上限的，加上"同实体已有 `PENDING` 行、让位成
   * `FAILED`"的。两者都终结这一行，原因由 `last_error` 区分。
   */
  failed: number
  /**
   * 被直接置 `FAILED` 的行 id（与 `failed` 同序同长）。
   *
   * 顺序：先是 `attempts` 用尽的，然后是让位的。
   *
   * 给调用方"对这些终结失败做点事后处理"用：`index.ts` 拿它去补投一条延迟的 `EMBED_*`
   * （见 `jobs/embedding/requeue.ts`）——没有这个列表，启动回收判死的行就和"3 次失败后无补投"
   * 一样没人管，而这两条路径产生的是同一种终态。让位的行走到那里会被 `NOT EXISTS` 挡掉
   * （同实体的 `PENDING` 已经存在），不会多投一条。
   */
  failedIds: string[]
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

/**
 * 每个 `JobType` 的"同实体"键，必须与 `packages/db/src/schema/jobs.ts` 的 6 条 partial unique
 * index 一一对应（那些索引的键都是单个 `payload->>'xxx'`）。
 *
 * 只用于一件事：判断"同实体是否已经有一条 `PENDING` 行"。漏掉一个类型，那个类型的让位判定就会
 * 漏判，于是它的回退仍然撞 23505——本模块要堵的正是这个洞，所以这里用 `Record<JobType, …>`
 * 让新增 `JobType` 时在编译期就报出来。
 */
const PENDING_DEDUPE_KEY: Record<JobType, string> = {
  MATCH_LISTING: 'listingId',
  MATCH_WISH: 'wishId',
  EMBED_LISTING: 'listingId',
  EMBED_WISH: 'wishId',
  REFRESH_USER_INTEREST: 'userId',
  VISUAL_EMBED_LISTING: 'listingId',
}

/**
 * "另一行 `o` 与目标行 `j` 是同一实体的同类 job"。
 *
 * 表达式必须与那 6 条 partial unique index 的键**完全一致**：索引会不会拦、让位会不会命中，靠的
 * 是同一个 `payload->>'xxx'`。两边一旦走偏，就会出现"索引拦得住但让位看不见"的死锁式 bug。
 * （顺带一提：`payload` 必须是**真 jsonb 对象**才会有键——裸对象经 drizzle + bun-sql 会被
 * stringify 两次、落成 jsonb 字符串，那时 `->>` 为 NULL，索引对那行也形同不存在，
 * 见 `packages/db/src/json.ts` 的 `jsonParam`。）
 *
 * 键名走 `sql.raw`：`payload->>$n` 的 `text` / `integer` 两个重载在 bind 参数上有歧义
 * （与 `jobs/embedding/requeue.ts:121` 同一取舍）；键名来自上面的固定映射表，没有注入面。
 */
function sameEntityPredicate(): SQL {
  return sql.join(
    Object.entries(PENDING_DEDUPE_KEY).map(
      ([type, key]) =>
        sql`(o.type = ${type} and ${sql.raw(`o.payload->>'${key}'`)} = ${sql.raw(
          `j.payload->>'${key}'`,
        )})`,
    ),
    sql` or `,
  )
}

/**
 * 23505 = `unique_violation`。
 *
 * drizzle 会把驱动错误包成 `DrizzleQueryError`，真正的 SQLSTATE 在 `cause` 链里（`bun-sql` 的
 * `PostgresError` 用 `errno` 携带它，标准 pg 驱动用 `code`），所以两种都认、并且沿 `cause` 走。
 * 与 `apps/api/src/modules/auth/unique.ts:8` 同一个判据，只是 worker 不跨包引 API 内部文件。
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if ('errno' in current && current.errno === '23505') return true
    if ('code' in current && current.code === '23505') return true
    current = current.cause
  }
  return false
}

/**
 * 让位行写进 `last_error` 的值：先是让位原因，再**保留上一次的失败原因**当证据。
 *
 * 与 `recoverStaleClaims()` 回退分支"保留上一次失败原因"同一取舍：只写让位原因会把"这行上一次
 * 为什么失败"的证据丢掉，而那个原因恰恰是排障时要看的。SQL 侧按同样格式拼
 * （`${SUPERSEDED_BY_PENDING_ERROR} || coalesce(': ' || last_error, '')`）。
 */
function supersededReason(previous: string | null): string {
  return previous === null || previous === ''
    ? SUPERSEDED_BY_PENDING_ERROR
    : `${SUPERSEDED_BY_PENDING_ERROR}: ${previous}`
}

/**
 * `recoverStaleClaims()` 撞 23505 时的重试次数。
 *
 * 让位语句与回退语句之间有一段极窄的竞态：投递侧可能正好在这两条语句之间提交一条同实体
 * `PENDING`。那时回退照样撞索引，但**下一轮**的让位语句就能看到那条 `PENDING` 并收敛，所以有界
 * 重试足够。重试用尽仍然失败说明是真问题（例如迁移没跑、索引不存在），按原样抛出去，不吞。
 */
const RECOVER_CONFLICT_ATTEMPTS = 3

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

  /**
   * 结算一行 job，返回**实际生效**的状态与 `last_error`。
   *
   * 与传入值只会在一种情况下不同：回退到 `PENDING` 时同实体已经有 `PENDING` 行（23505）——这时
   * 这行改成 `FAILED` 让位，状态随之变成 `'FAILED'`（见下面的注释）。
   */
  async function settle(
    id: string,
    status: 'DONE' | 'FAILED' | 'PENDING',
    lastError: string | null,
  ): Promise<{ status: 'DONE' | 'FAILED' | 'PENDING'; lastError: string | null }> {
    // 重试不引入退避：`run_at = now()` 让下一次轮询立刻再试（契约 §3.6）。
    // `locked_at` 必须清空：它表示"正被某个 worker 持有"，结算后这行已经不再被持有；
    // 留着会让僵死行的判读（以及任何按 locked_at 的观测）失真。
    // raw SQL 绕过 drizzle 的 `$onUpdate`，所以 `updated_at` 必须自己写，否则这一行的
    // `updated_at` 会停在“被领取前”（与 `schema/common.ts` 的“app 侧维护”约定不一致）。
    try {
      await db.execute(sql`
        UPDATE jobs
        SET status = ${status}, last_error = ${lastError}, run_at = now(), locked_at = NULL,
            updated_at = now()
        WHERE id = ${id}
      `)
      return { status, lastError }
    } catch (error) {
      // 回退到 `PENDING` 会撞 6 条 partial unique index 里的一条：`claimNext` 把行置成 `RUNNING`
      // 之后，投递侧照样可以合法地插一条同实体 `PENDING`（索引只覆盖 `PENDING` 的行，`claimNext`
      // 也只看 `PENDING` 的行）。这条行的重算已经由那条 `PENDING` 覆盖，而硬回退会抛 23505——
      // 异常会从 `runOnce` 冒到 `index.ts` 的主循环，整个 worker 停摆。
      // 所以让位：这行终态化成 `FAILED`，`last_error` 记让位原因 + 保留 handler 的原始错误。
      if (status !== 'PENDING' || !isUniqueViolation(error)) throw error
      const superseded = supersededReason(lastError)
      await db.execute(sql`
        UPDATE jobs
        SET status = 'FAILED', last_error = ${superseded}, run_at = now(),
            locked_at = NULL, updated_at = now()
        WHERE id = ${id}
      `)
      return { status: 'FAILED', lastError: superseded }
    }
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
   *
   * **让位**：`RUNNING` 行回到 `PENDING` 时同实体可能已经有一条 `PENDING`（job 被领走之后投递侧又
   * 插了一条——`claimNext` 只看 `PENDING`，所以这完全合法），直接回退会撞 partial unique index
   * （23505）。撞在启动路径上的后果特别重：`index.ts` 的顶层 `await recoverStaleClaims()` 没有
   * try/catch，worker **每次重启都会死在启动那一刻**，只有人工删掉那条 `PENDING` 才能恢复。
   * 所以回收先做一次让位：这类僵死行直接置 `FAILED`（重算交给那条 `PENDING`），再回退。
   */
  async function recoverStaleClaims(): Promise<RecoveredClaims> {
    // 三条 UPDATE 放在同一事务里：否则先提交的语句执行后、后一条执行前被别的领取者改成 RUNNING 的行
    // 会被按 `attempts >= max` 误判成 FAILED。
    // 谓词不重叠：让位带走"同实体已有 PENDING"的 RUNNING 行，回退带走剩下的 `attempts < max` 的，
    // 最后一条只剩 `attempts >= max` 的（它写 FAILED，不碰唯一索引）。
    // raw SQL 绕过 `$onUpdate`，所以 `updated_at` 自己写（否则被回收过的行看不出被回收过）。
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await db.transaction(async (tx) => {
          const superseded = toRows(
            await tx.execute(sql`
              UPDATE jobs AS j
              SET status = 'FAILED',
                  last_error = ${SUPERSEDED_BY_PENDING_ERROR} || coalesce(': ' || j.last_error, ''),
                  run_at = now(), locked_at = NULL, updated_at = now()
              WHERE j.status = 'RUNNING' AND j.attempts < ${maxAttempts}
                AND EXISTS (
                  SELECT 1 FROM jobs AS o
                  WHERE o.status = 'PENDING' AND o.id <> j.id AND (${sameEntityPredicate()})
                )
              RETURNING j.id
            `),
          )
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

          return {
            requeued: requeued.length,
            // 让位的行和 attempts 用尽的行都是"被回收直接置 FAILED"的同一终态，调用方不需要区分。
            failed: failed.length + superseded.length,
            failedIds: [...failed, ...superseded].map((row) => String(row.id)),
          }
        })
      } catch (error) {
        // 让位与回退之间投递侧提交了一条同实体 PENDING 时会照样撞索引：下一轮的让位就能看到它。
        if (!isUniqueViolation(error) || attempt >= RECOVER_CONFLICT_ATTEMPTS) throw error
      }
    }
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
        // 在错误类型/参数信息尚在时脱敏，落库后的字符串会直接进入 Worker job.settled 日志。
        const lastError =
          error instanceof Error ? `${error.name}: ${errorMessage(error)}` : errorMessage(error)
        const fatal = (deps.isFatalError?.(error) ?? false) || job.attempts >= maxAttempts
        const requested = fatal ? 'FAILED' : 'PENDING'
        const settled = await settle(job.id, requested, lastError)
        // 让位时如实报告实际生效的状态与原因：库里写的是它，`job.settled` 日志里也必须是它。
        return { id: job.id, type: job.type, status: settled.status, lastError: settled.lastError }
      }
    },
  }
}
