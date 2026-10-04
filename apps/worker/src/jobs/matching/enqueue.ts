/**
 * 从 worker 侧补投一条 `MATCH_*` job（#322 M4 复审修复）。
 *
 * **为什么需要它**：API 侧"成对投递"（`EMBED_*` 在前、`MATCH_*` 在后）只保证了**入队时刻**的
 * 顺序，队列自己的两条路径会把执行序反过来：
 * - `settle()` 对非致命失败写 `run_at = now()`（`queue.ts`），把这条 job 推到队尾；
 * - `recoverStaleClaims()` 对 `kill -9` 遗留的 `RUNNING` 行同样写 `run_at = now()`。
 *
 * 于是 `MATCH_*` 可能先跑：那时目标实体还没有本模型向量，引擎走 `v1-fallback`（`ranking_version
 * = 1`）并补投一条 `EMBED_*`——而 `EMBED_*` 跑完之后，**没有任何东西会再触发一次匹配**，
 * 这一对就永久停在 v1（M4 §6.1 的"入队序不变量"在重试路径上并不成立）。
 *
 * 修法是把不变量的另一半补在**执行侧**：`EMBED_*` 一旦确认向量新鲜（`generated` / `unchanged`）
 * 就补投一条同实体的 `MATCH_*`（调用点见 `apps/worker/src/jobs/embedding/handlers.ts`）。
 * 这条新 job 在 `EMBED_*` 结算之前插入，所以它的 `(run_at, id)` 必然晚于那次 `EMBED_*`；
 * 而它跑的时候向量已经新鲜 ⇒ 走 `vector-topk`、不再补投 `EMBED_*` ⇒ 链条自行终止。
 *
 * **去重**：`MATCH_WISH` 和 `MATCH_LISTING` 都有 partial unique index
 * （`jobs_match_wish_wish_id_pending_uidx` / `jobs_match_listing_listing_id_pending_uidx`；
 * 后者是 #322 M4 §12.1 缺口一的收口，见 `packages/db/src/schema/jobs.ts`）。下面的
 * `WHERE NOT EXISTS (… status = 'PENDING')` 保留为**廉价预过滤**：常见路径上（编辑商品时 API
 * 已投过 `MATCH_LISTING`，它还 PENDING）这条 INSERT 直接不插入，不产生一次冲突。但
 * `NOT EXISTS` 与 `INSERT` 之间没有锁，两个插入者可以同时通过它——原子性由索引 +
 * `ON CONFLICT DO NOTHING` 保证，不再只靠 `NOT EXISTS`。
 */
import { MATCH_JOB_TYPES } from '@fish/contracts/matching/jobs'
import type { Db } from '@fish/db/client'
import type { EmbeddingEntity } from '@fish/db/embedding-store'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

/** 只要求能执行一条 INSERT，便于调用方传事务句柄或普通连接。 */
export async function enqueueMatchJob(
  db: Pick<Db, 'execute'>,
  entity: EmbeddingEntity,
): Promise<void> {
  const type = entity.kind === 'listing' ? MATCH_JOB_TYPES.listing : MATCH_JOB_TYPES.wish
  const payload = JSON.stringify(
    entity.kind === 'listing' ? { listingId: entity.id } : { wishId: entity.id },
  )
  const pending =
    entity.kind === 'listing'
      ? sql`payload->>'listingId' = ${entity.id}`
      : sql`payload->>'wishId' = ${entity.id}`

  // `::text::jsonb` 两段转型与 `enqueueEmbedJob` 同理：drizzle(0.45) + bun-sql 下直接 `::jsonb`
  // 会把已序列化的字符串再编码一次，落库成 jsonb 字符串标量，`payload->>'…'` 恒为 NULL。
  await db.execute(sql`
    INSERT INTO jobs (id, type, payload)
    SELECT ${newId()}, ${type}, ${payload}::text::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE type = ${type} AND status = 'PENDING' AND ${pending}
    )
    ON CONFLICT DO NOTHING
  `)
}
