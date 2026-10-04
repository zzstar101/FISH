/**
 * `EMBED_*` job **终结失败后的有界补投**（#322 M4 复审修复：范围外发现 #2）。
 *
 * 背景：`queue.ts` 在 `attempts >= maxAttempts` 时把 job 置 `FAILED` 终态。此后没有任何东西会再
 * 为这个实体排一条 `EMBED_*` —— 除非用户又编辑了一次（API 侧重新投递），或者有人手动跑
 * `bun run embed:backfill`。而 `MATCH_*` 侧一旦发现目标向量缺失/过期就退回 v1 口径
 * （`jobs/matching/engine.ts` 的 v1-fallback），所以一次上游抖动就可能让这个实体的所有匹配
 * 永久停在 v1 上。M1 §12 第 5 条与 M3 §10.6 把这个"3 次失败后无补投"留给了 M4。
 *
 * 这里的策略是**有界重试**，不是无限重试：
 * - `FAILED` 之后排一条新的 `EMBED_*`，`run_at` 推后 `FAILED_EMBED_RETRY_DELAY_MS`，给上游留出恢复时间；
 * - 同一实体在 `FAILED_EMBED_RETRY_WINDOW_MS` 窗口内**最多失败 `FAILED_EMBED_RETRY_LIMIT` 条**
 *   `EMBED_*`（含本次），到顶后不再自动重试 —— 永久坏掉的实体（维度配错、文本被上游拒绝）
 *   不会无限烧配额，剩下的路是人工：`obs:summary` 的 `failedJobs` / `jobs.withError` /
 *   `obs.retries`（额度用尽的实体明细，见下面的 `listExhaustedEmbedRetries()`）与
 *   `bun run embed:backfill`；
 * - 坏的 payload（`InvalidJobPayloadError` 那条路径）不补投：payload 不会自己变好；
 * - 已有 `PENDING` 的同实体任务时不重复投（与 `./enqueue.ts` 的 partial unique index 同一语义）。
 *
 * 与 `./enqueue.ts` 一致，payload 只放实体 id，并用 `::text::jsonb` 两段转型（`packages/db/src/json.ts`
 * 记录的 bun-sql 双重序列化坑）。
 */
import { EMBED_JOB_TYPES } from '@fish/contracts/embedding/jobs'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'
import { parseJobPayload, toRows } from '../queue'

/** 同一实体在窗口内允许出现多少条 `FAILED` 的 `EMBED_*`（含触发补投的那条）。 */
export const FAILED_EMBED_RETRY_LIMIT = 3
/** 计数窗口：超过这个时间的旧失败不再压额度（上游恢复后会重新获得补投机会）。 */
export const FAILED_EMBED_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000
/** 补投的延迟：不立刻重试，避免上游还没恢复就把额度又烧光。 */
export const FAILED_EMBED_RETRY_DELAY_MS = 60 * 1000

export type FailedEmbedRetryReason =
  /** 不是 `EMBED_*`（`MATCH_*` 的失败不在这里补投）。 */
  | 'not-embed'
  /** 行不存在，或已经不是 `FAILED`（被别人改过）。 */
  | 'not-failed'
  /** payload 里没有实体 id：补投只会再失败一次。 */
  | 'bad-payload'
  /** 窗口内的失败条数已达上限。 */
  | 'budget-exhausted'
  /** 该实体已有待跑的 `EMBED_*`。 */
  | 'already-pending'

export type FailedEmbedRetryResult = {
  /** 是否真的排入了一条新的 `EMBED_*`。 */
  scheduled: boolean
  /** 补投/检查的 job 类型（`scheduled === false` 且非 EMBED 类型时为 `null`）。 */
  type: string | null
  /** payload 里的实体键与 id（用于日志；不含任何用户文本）。 */
  entityKey: 'listingId' | 'wishId' | null
  entityId: string | null
  /** 窗口内的失败条数（含触发本次补投的那条）。 */
  failedInWindow: number
  /** 未排入时的原因；排入时为 `null`。 */
  reason: FailedEmbedRetryReason | null
  /** 排入时用的延迟（毫秒）；未排入时为 `null`。 */
  delayMs: number | null
}

/** `EMBED_*` 的 job 类型 → payload 里的实体键。非 EMBED 类型返回 `null`。 */
function embedEntityKey(type: string): 'listingId' | 'wishId' | null {
  if (type === EMBED_JOB_TYPES.listing) return 'listingId'
  if (type === EMBED_JOB_TYPES.wish) return 'wishId'
  return null
}

function skip(
  reason: FailedEmbedRetryReason,
  fields: {
    type: string | null
    entityKey: 'listingId' | 'wishId' | null
    entityId: string | null
  },
): FailedEmbedRetryResult {
  return {
    scheduled: false,
    type: fields.type,
    entityKey: fields.entityKey,
    entityId: fields.entityId,
    failedInWindow: 0,
    reason,
    delayMs: null,
  }
}

/**
 * 检查一条刚被判 `FAILED` 的 job；是 `EMBED_*` 且在额度内时，排一条延迟执行的同实体新 job。
 *
 * 调用点在 worker 主循环（`index.ts`）与启动回收之后 —— 两处都是"刚刚发生了终结失败"的时刻，
 * 所以这里按 id 查行、而不是全表扫描。
 */
export async function scheduleFailedEmbedRetry(
  db: Db,
  jobId: string,
): Promise<FailedEmbedRetryResult> {
  const rows = toRows(
    await db.execute(sql`SELECT type, status, payload FROM jobs WHERE id = ${jobId}`),
  )
  const row = rows[0]
  if (!row || String(row.status) !== 'FAILED') {
    return skip('not-failed', { type: null, entityKey: null, entityId: null })
  }

  const type = String(row.type)
  const entityKey = embedEntityKey(type)
  if (!entityKey) return skip('not-embed', { type, entityKey: null, entityId: null })

  const payload = parseJobPayload(row.payload)
  const entityId =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)[entityKey]
      : undefined
  if (typeof entityId !== 'string' || entityId.length === 0) {
    return skip('bad-payload', { type, entityKey, entityId: null })
  }

  // 实体 id 作为 bind 参数不参与 SQL 结构，只有 `payload->>'…'` 的键名走 `sql.raw`
  // （键名来自上面那张固定映射表，没有注入面）。
  const windowSec = FAILED_EMBED_RETRY_WINDOW_MS / 1000
  const failedRows = toRows(
    await db.execute(sql`
      SELECT count(*)::int AS count FROM jobs
      WHERE type = ${type}
        AND status = 'FAILED'
        AND ${sql.raw(`payload->>'${entityKey}'`)} = ${entityId}
        AND updated_at >= now() - make_interval(secs => ${windowSec}::double precision)
    `),
  )
  const failedInWindow = Number(failedRows[0]?.count ?? 0)

  if (failedInWindow >= FAILED_EMBED_RETRY_LIMIT) {
    return { ...skip('budget-exhausted', { type, entityKey, entityId }), failedInWindow }
  }

  const payloadJson = JSON.stringify(
    entityKey === 'listingId' ? { listingId: entityId } : { wishId: entityId },
  )
  const delaySec = FAILED_EMBED_RETRY_DELAY_MS / 1000
  const inserted = toRows(
    await db.execute(sql`
      INSERT INTO jobs (id, type, payload, run_at)
      SELECT ${newId()}, ${type}, ${payloadJson}::text::jsonb,
             now() + make_interval(secs => ${delaySec}::double precision)
      WHERE NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE type = ${type}
          AND status = 'PENDING'
          AND ${sql.raw(`payload->>'${entityKey}'`)} = ${entityId}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `),
  )

  if (inserted.length === 0) {
    return { ...skip('already-pending', { type, entityKey, entityId }), failedInWindow }
  }

  return {
    scheduled: true,
    type,
    entityKey,
    entityId,
    failedInWindow,
    reason: null,
    delayMs: FAILED_EMBED_RETRY_DELAY_MS,
  }
}

/** 一个**额度已用尽**的实体：窗口内的 `FAILED` 条数已达 `FAILED_EMBED_RETRY_LIMIT`。 */
export type ExhaustedEmbedRetry = {
  /** `EMBED_LISTING` / `EMBED_WISH`。 */
  type: string
  entityKey: 'listingId' | 'wishId'
  entityId: string
  /** 窗口内的 `FAILED` 条数（≥ 上限）。 */
  failedInWindow: number
  /** 该实体还有待跑的 `EMBED_*`：额度虽已用尽，但自动路径还没断（例如用户又编辑了一次）。 */
  pending: boolean
}

/**
 * 列出**额度已用尽**的实体（#322 M4 §12.1 缺口 #2 的收口）。
 *
 * 为什么需要它：`scheduleFailedEmbedRetry()` 判到 `budget-exhausted` 时只写一行 stderr
 * （`embed.retry`，`apps/worker/src/index.ts`），而 stderr 是**流**不是**状态**：事后没人能回答
 * "现在有哪些实体已经不再自动重试了"。这个函数把同一判据（同一张表、同一组
 * `FAILED_EMBED_RETRY_LIMIT` / `FAILED_EMBED_RETRY_WINDOW_MS` 常量）变成一条可反复查询的 SQL，
 * 由 `apps/worker/scripts/obs-summary.ts` 聚合成 `obs.retries` 事件与 `obs.summary` 的
 * `exhaustedEmbedRetries` / `stuckEmbedRetries` 两个计数。
 *
 * 口径与补投路径逐条对齐：
 * - 只算 `EMBED_LISTING` / `EMBED_WISH`（`MATCH_*` 的失败不补投）；
 * - 实体键按 `type` 决定（与 `embedEntityKey()` 同一张映射表），`payload` 里没有该键的行不参与分组
 *   （补投对它们只会再失败一次，见 `bad-payload`）；
 * - 窗口与上限直接复用上面两个常量，改额度不会让这个口径漂移；
 * - `pending` 是**附加信息**而不是过滤条件：额度用尽本身就是"这个实体已经烧完 24 小时配额"，
 *   但只有 `pending === false` 的那些才是"自动路径已断、只能人工 `embed:backfill`"。
 *
 * 仓库里没有告警基建（没有 metrics / 通知服务，见 `apps/worker/src/log.ts` 的约定），所以这里给的是
 * **可查询、可聚合的计数**，不等同于真正的告警通道。
 */
export async function listExhaustedEmbedRetries(db: Db): Promise<ExhaustedEmbedRetry[]> {
  const windowSec = FAILED_EMBED_RETRY_WINDOW_MS / 1000
  const rows = toRows(
    await db.execute(sql`
      WITH failed AS (
        SELECT
          type,
          CASE
            WHEN type = ${EMBED_JOB_TYPES.listing} THEN payload->>'listingId'
            ELSE payload->>'wishId'
          END AS entity_id
        FROM jobs
        WHERE type IN (${EMBED_JOB_TYPES.listing}, ${EMBED_JOB_TYPES.wish})
          AND status = 'FAILED'
          AND updated_at >= now() - make_interval(secs => ${windowSec}::double precision)
      )
      SELECT
        f.type,
        f.entity_id,
        count(*)::int AS failed_in_window,
        EXISTS (
          SELECT 1 FROM jobs p
          WHERE p.type = f.type
            AND p.status = 'PENDING'
            AND CASE
              WHEN p.type = ${EMBED_JOB_TYPES.listing} THEN p.payload->>'listingId'
              ELSE p.payload->>'wishId'
            END = f.entity_id
        ) AS pending
      FROM failed f
      WHERE f.entity_id IS NOT NULL
      GROUP BY f.type, f.entity_id
      HAVING count(*) >= ${FAILED_EMBED_RETRY_LIMIT}::int
      ORDER BY f.type, f.entity_id
    `),
  )

  const exhausted: ExhaustedEmbedRetry[] = []
  for (const row of rows) {
    const type = String(row.type)
    const entityKey = embedEntityKey(type)
    const entityId = row.entity_id
    if (!entityKey || typeof entityId !== 'string' || entityId.length === 0) continue
    exhausted.push({
      type,
      entityKey,
      entityId,
      failedInWindow: Number(row.failed_in_window ?? 0),
      pending: row.pending === true,
    })
  }
  return exhausted
}
