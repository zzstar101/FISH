/**
 * 从 worker 侧补投一条 `EMBED_*` job（#322 M2）。
 *
 * 为什么 worker 也需要投递：M2 的召回要求"目标实体有本模型的、与当前内容一致的向量"。
 * 当向量缺失 / 过期 / 只有旧模型时，匹配**不能等**（等待会让该目标已有的 `matches` 停止重算，
 * 旧高分永久残留），所以本轮退回 v1 的结构化全量候选，同时补一条 EMBED job，让下一轮就能用上向量。
 *
 * 与 API 侧 `apps/api/src/modules/wishes/match-queue.ts` 的三点保持一致：
 * - `::text::jsonb` 两段转型：本仓 drizzle(0.45) + bun-sql 组合下，直接 `${...}::jsonb` 会把已序列化的
 *   字符串再编码一次，落库为 jsonb **字符串标量**，消费方 `payload->>'listingId'` 恒为 NULL；
 * - payload 只放实体 id：文本与指纹由 handler 现查实体后构造，避免 payload 与实体行漂移；
 * - `ON CONFLICT DO NOTHING` 打在 `(payload->>'…') WHERE type=… AND status='PENDING'` 的 partial
 *   unique index 上：同一实体已有待跑任务时静默忽略；任务跑完（DONE/FAILED）后再退化才会补新的一条。
 */
import { EMBED_JOB_TYPES } from '@fish/contracts/embedding/jobs'
import type { Db } from '@fish/db/client'
import type { EmbeddingEntity } from '@fish/db/embedding-store'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

/** 只要求能执行一条 INSERT，便于调用方传事务句柄或普通连接。 */
export async function enqueueEmbedJob(
  db: Pick<Db, 'execute'>,
  entity: EmbeddingEntity,
): Promise<void> {
  const type = entity.kind === 'listing' ? EMBED_JOB_TYPES.listing : EMBED_JOB_TYPES.wish
  const payload = entity.kind === 'listing' ? { listingId: entity.id } : { wishId: entity.id }

  await db.execute(sql`
    INSERT INTO jobs (id, type, payload)
    VALUES (${newId()}, ${type}, ${JSON.stringify(payload)}::text::jsonb)
    ON CONFLICT DO NOTHING
  `)
}
