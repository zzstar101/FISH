import { and, eq, sql } from 'drizzle-orm'
import type { Db } from './client'
import { newId } from './ids'
import { embeddings } from './schema/embeddings'

/**
 * 向量行的读写（#322 M1）。
 *
 * 只做"取一行 / 落一行"，**不构造文本、不调用 provider、不判失效**——那些在
 * `@fish/contracts/embedding/text`（文本与内容指纹）与
 * `apps/worker/src/jobs/embedding/handlers.ts`（生成决策）里。这样 M2 的召回与 M4 的
 * backfill 可以复用同一存取层，而不必各自再写一遍 SQL。
 */

/** 向量指向的实体。单表双可空 FK，所以"哪个实体"必须是显式参数（见 `schema/embeddings.ts`）。 */
export type EmbeddingEntity = { kind: 'listing'; id: string } | { kind: 'wish'; id: string }

/** 一行向量（不含指向哪个实体——调用方本来就知道自己查的是谁）。 */
export type EmbeddingRow = {
  model: string
  dimensions: number
  contentHash: string
  embedding: number[]
}

export type SaveEmbeddingInput = {
  entity: EmbeddingEntity
  model: string
  dimensions: number
  contentHash: string
  embedding: number[]
}

function entityFilter(entity: EmbeddingEntity) {
  return entity.kind === 'listing'
    ? eq(embeddings.listingId, entity.id)
    : eq(embeddings.wishId, entity.id)
}

/**
 * 读某个实体在**指定模型**下的向量。
 *
 * `model` 是必填参数而不是默认值：同一实体可能同时存在新旧模型的向量（唯一键含 `model`），
 * 不带模型查询就会随机拿到一套向量去算相似度——那正是 #322 要禁止的"静默混用不同模型向量"。
 */
export async function findEmbedding(
  db: Db,
  entity: EmbeddingEntity,
  model: string,
): Promise<EmbeddingRow | null> {
  const rows = await db
    .select({
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      contentHash: embeddings.contentHash,
      embedding: embeddings.embedding,
    })
    .from(embeddings)
    .where(and(entityFilter(entity), eq(embeddings.model, model)))
    .limit(1)

  return rows[0] ?? null
}

/**
 * 写入/覆盖某实体在某模型下的向量（`(entity, model)` 唯一）。
 *
 * 覆盖是刻意的：内容改动后重新生成的向量必须替换旧值，否则读侧会永远拿到旧向量。
 * 旧的**别的模型**的行不动（M4 的换模型重建负责清理），读侧按 `model` 过滤即可。
 */
export async function saveEmbedding(db: Db, input: SaveEmbeddingInput): Promise<void> {
  const listingId = input.entity.kind === 'listing' ? input.entity.id : null
  const wishId = input.entity.kind === 'wish' ? input.entity.id : null

  const values = {
    id: newId(),
    listingId,
    wishId,
    model: input.model,
    dimensions: input.dimensions,
    contentHash: input.contentHash,
    embedding: input.embedding,
  }

  // `updated_at` 必须显式写：`$onUpdate` 只挂在 drizzle 的 `.update()` 上，onConflict 的
  // `set` 走的是原始 insert 路径（与 `apps/worker/src/jobs/queue.ts` 的 settle 同一注意点）。
  const patch = {
    dimensions: input.dimensions,
    contentHash: input.contentHash,
    embedding: input.embedding,
    updatedAt: new Date(),
  }

  // 冲突目标必须带 partial index 的谓词，否则 PG 无法把 (col, model) 推断到那条 partial
  // unique index 上（两条 partial 索引的形状相同，只差哪一列非空）。
  if (listingId !== null) {
    await db
      .insert(embeddings)
      .values(values)
      .onConflictDoUpdate({
        target: [embeddings.listingId, embeddings.model],
        targetWhere: sql`${embeddings.listingId} is not null`,
        set: patch,
      })
    return
  }

  await db
    .insert(embeddings)
    .values(values)
    .onConflictDoUpdate({
      target: [embeddings.wishId, embeddings.model],
      targetWhere: sql`${embeddings.wishId} is not null`,
      set: patch,
    })
}
