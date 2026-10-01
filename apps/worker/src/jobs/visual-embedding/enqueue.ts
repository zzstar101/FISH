/**
 * 投递一条 `VISUAL_EMBED_LISTING` job（#324 M8）。
 *
 * 与 #322 的 `jobs/embedding/enqueue.ts` 三点保持一致（理由见那边的注释，此处不重复展开）：
 * - `::text::jsonb` 两段转型：本仓 drizzle(0.45) + bun-sql 下直接 `::jsonb` 会把已序列化的
 *   字符串再编码一次，落库成 jsonb **字符串标量**，`payload->>'listingId'` 恒为 NULL；
 * - payload 只放 id：封面与模型都在 handler 运行时现查，旧 job 晚到也只会按**当前**封面重算；
 * - `ON CONFLICT DO NOTHING` 打在 `jobs_visual_embed_listing_listing_id_pending_uidx`
 *   这个 partial unique index 上：同一商品已有待跑任务时静默忽略。
 */
import { VISUAL_EMBED_JOB_TYPES } from '@fish/contracts/visual/jobs'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

/**
 * bun-sql 的 `execute` 可能返回数组，也可能返回 `{ rows }`（与 `packages/db/src/migrate.ts`
 * 的 `rowsOf` 同构）；`RETURNING` 的结果必须两种形状都能读。
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

/**
 * 只要求能执行一条 INSERT，便于调用方传事务句柄或普通连接。
 *
 * 返回**是否真的插入了新行**：`ON CONFLICT DO NOTHING` 命中已有待跑任务时静默跳过，
 * 此时返回 `false`。回填据此报告真实投递量，而不是候选数——否则重复跑一轮会把
 * "扫到 50 条候选"报成"投递 50 条"，运维看到的是虚数。
 */
export async function enqueueVisualEmbedJob(
  db: Pick<Db, 'execute'>,
  listingId: string,
): Promise<boolean> {
  const payload = { listingId }

  const inserted = rowsOf(
    await db.execute(sql`
      INSERT INTO jobs (id, type, payload)
      VALUES (${newId()}, ${VISUAL_EMBED_JOB_TYPES.listing}, ${JSON.stringify(payload)}::text::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING id
    `),
  )

  return inserted.length > 0
}
