import { and, asc, eq, gt, type SQL, sql } from 'drizzle-orm'
import type { Db } from './client'
import { newId } from './ids'
import { listingImages, listings } from './schema/listings'
import { listingVisualEmbeddings } from './schema/visual-embeddings'

/**
 * 视觉向量行的读写与召回（#324 M3/M4/M8）。
 *
 * 与 #322 的 `embedding-store.ts` 同一分工：这里只做"取一行 / 落一行 / 召回 Top-K"，
 * **不读图片字节、不调用 provider、不构造解析文本**——那些在 worker 的
 * `jobs/visual-embedding/` 与 API 的 `modules/visual-search/`。
 *
 * ## 与文本侧最关键的一处分歧：新鲜度判据是**封面对象键**，不是实体版本号
 *
 * #322 的候选新鲜度是 `source_updated_at = 实体当前 updated_at`，因为文本向量由
 * "标题+描述+分类"决定，任何编辑都可能让向量过期。视觉向量的输入**只有封面图**：
 * 改价格、改标题、改描述都不该让视觉向量失效——按版本号判会把"改个价"变成
 * "拍照搜不到这件商品直到重新回填"，而重新嵌入一张图是要花钱的。
 *
 * 所以这里的判据是 `source_object_key = 当前封面的 object_key`：
 * - 封面被替换 = 新的上传对象 = 新的 final key（`listing_media_objects_final_key_uq`
 *   保证 final key 与内容一一对应）⇒ 旧向量立刻不可召回；
 * - 文本/价格/状态编辑不影响视觉向量 ⇒ 不触发无谓的重新嵌入；
 * - 封面被**删除**（没有 `sort_order = 0` 的行）⇒ inner join 自然排除。
 *
 * `source_updated_at` 仍然存在，但只承担**写入先后**（CAS），不再承担新鲜度。
 */

/** 只声明本模块用到的方法：`Db` 与事务里的 `tx` 都能直接传进来。 */
export type VisualEmbeddingExecutor = Pick<Db, 'select' | 'insert' | 'delete'>

export type VisualEmbeddingRow = {
  model: string
  dimensions: number
  /** 生成该向量时的封面对象键（召回时的新鲜度判据）。 */
  sourceObjectKey: string
  embedding: number[]
  sourceUpdatedAt: Date
}

export type SaveVisualEmbeddingInput = {
  listingId: string
  model: string
  dimensions: number
  sourceObjectKey: string
  embedding: number[]
  /** 本次生成所依据的 Listing 版本（读 Listing 那一刻的 `updated_at`）。 */
  sourceUpdatedAt: Date
}

/**
 * 读某个 Listing 在**指定模型**下的视觉向量。
 *
 * `model` 必填（与 #322 同一理由）：同一 Listing 可能同时存在新旧模型的向量，
 * 不带模型查询就会静默混用两套向量算相似度。
 */
export async function findVisualEmbedding(
  executor: Pick<Db, 'select'>,
  listingId: string,
  model: string,
): Promise<VisualEmbeddingRow | null> {
  const rows = await executor
    .select({
      model: listingVisualEmbeddings.model,
      dimensions: listingVisualEmbeddings.dimensions,
      sourceObjectKey: listingVisualEmbeddings.sourceObjectKey,
      embedding: listingVisualEmbeddings.embedding,
      sourceUpdatedAt: listingVisualEmbeddings.sourceUpdatedAt,
    })
    .from(listingVisualEmbeddings)
    .where(
      and(
        eq(listingVisualEmbeddings.listingId, listingId),
        eq(listingVisualEmbeddings.model, model),
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/**
 * 写入/覆盖某 Listing 在某模型下的视觉向量（`(listing_id, model)` 唯一）。
 *
 * CAS 与 #322 同形：`ON CONFLICT DO UPDATE ... WHERE excluded.source_updated_at >= 目标`，
 * 返回值 `false` 表示被更新的版本抢先（调用方记 `stale`，不得当成成功）。
 * 这里是**纵深防御**——真正的"旧写入不能覆盖新向量"由调用方在同一条事务里
 * `FOR UPDATE` 锁住 Listing 行、复检封面键来保证（见 worker handler）。
 */
export async function saveVisualEmbedding(
  executor: Pick<Db, 'insert'>,
  input: SaveVisualEmbeddingInput,
): Promise<boolean> {
  // `updated_at` 必须显式写：`$onUpdate` 只挂在 Drizzle 的 `.update()` 上。
  const rows = await executor
    .insert(listingVisualEmbeddings)
    .values({
      id: newId(),
      listingId: input.listingId,
      model: input.model,
      dimensions: input.dimensions,
      sourceObjectKey: input.sourceObjectKey,
      embedding: input.embedding,
      sourceUpdatedAt: input.sourceUpdatedAt,
    })
    .onConflictDoUpdate({
      target: [listingVisualEmbeddings.listingId, listingVisualEmbeddings.model],
      set: {
        dimensions: input.dimensions,
        sourceObjectKey: input.sourceObjectKey,
        embedding: input.embedding,
        sourceUpdatedAt: input.sourceUpdatedAt,
        updatedAt: new Date(),
      },
      setWhere: sql`excluded."source_updated_at" >= ${listingVisualEmbeddings.sourceUpdatedAt}`,
    })
    .returning({ id: listingVisualEmbeddings.id })

  return rows.length > 0
}

/**
 * 候选新鲜度谓词：向量必须对应当前封面（#324 M8「图片替换自动失效」的主判据）。
 *
 * 不比较时间戳（理由见文件头）：封面键相等就是"这张向量描述的是现在这张图"。
 * 所以**不需要**在封面变更时删旧行：`(listing_id, model)` 只有一行，回填时 `ON CONFLICT`
 * 直接把它覆盖成新封面的向量；旧行在覆盖之前就已经召回不到了。
 */
function freshVisualEmbedding(): SQL {
  return sql`${listingVisualEmbeddings.sourceObjectKey} = ${listingImages.objectKey}`
}

/** 一条视觉召回候选：`distance` 是 cosine **距离**（0 = 同向、2 = 反向）。 */
export type VisualSimilarCandidate = { id: string; distance: number }

export type VisualSimilarQuery = {
  /** 必须显式给出：不同模型的向量不可比较。 */
  model: string
  /** 查询向量（查询图的向量，或 M5 文本路用同一模型算出的文本向量）。 */
  vector: number[]
  limit: number
  /**
   * 结构化的硬约束（可见性、排除自己等）。**必须带**：先过滤再取 Top-K，
   * 而不是先全域取 Top-K 再过滤——后者会让被挡掉的候选挤掉合法候选。
   */
  filter?: SQL
}

/**
 * 视觉召回（#324 M4）：与查询向量最相近的前 `limit` 条**可见**商品。
 *
 * 三个 join 都是必须的：
 * - `listings`：可见性过滤与"取卡片"的目标行；
 * - `listing_images`（`sort_order = 0`）：封面，同时提供新鲜度判据；
 * - 无 ANN 索引（与 #322 M2 同一判断）：当前数据量下 `ORDER BY embedding <=> $1 LIMIT K`
 *   的 exact scan 足够，上了 ANN 反而要在"过滤后再排序"上做额外取舍。
 */
export async function topKSimilarListingsByVisual(
  db: Db,
  query: VisualSimilarQuery,
): Promise<VisualSimilarCandidate[]> {
  const vector = JSON.stringify(query.vector)

  return db
    .select({
      id: listings.id,
      distance: sql<number>`${listingVisualEmbeddings.embedding} <=> ${vector}::vector`,
    })
    .from(listingVisualEmbeddings)
    .innerJoin(listings, eq(listings.id, listingVisualEmbeddings.listingId))
    .innerJoin(
      listingImages,
      and(eq(listingImages.listingId, listings.id), eq(listingImages.sortOrder, 0)),
    )
    .where(
      and(eq(listingVisualEmbeddings.model, query.model), freshVisualEmbedding(), query.filter),
    )
    .orderBy(sql`${listingVisualEmbeddings.embedding} <=> ${vector}::vector`)
    .limit(query.limit)
}

/** 回填批次里的一行：待（重新）嵌入封面的商品。 */
export type VisualBackfillCandidate = {
  listingId: string
  coverObjectKey: string
  updatedAt: Date
}

/**
 * 回填（#324 M8）：取下一批**需要**视觉向量的商品。
 *
 * "需要" = 有封面，且（没有本模型的向量 **或** 向量指向的不是当前封面）。
 * 因此这个查询天然可断点续跑：已经做好的行不会再次出现，重跑不会重复计费。
 *
 * 游标是 `listings.id > afterId`：uuidv7 单调递增，所以按 id 升序翻页等价于按创建顺序翻页，
 * 而且**与结果集变化无关**——批处理过程中前面那些行被修好、从结果里消失，也不会导致漏行或重行。
 *
 * 不看 `listings.status`：可见性由召回侧把关，回填侧只做"给每张封面算一个向量"，
 * 这样商品下架再上架不需要重新嵌入（省一次上游调用）。
 */
export async function listVisualEmbeddingBackfillBatch(
  db: Db,
  query: { model: string; limit: number; afterId?: string | null },
): Promise<VisualBackfillCandidate[]> {
  const rows = await db
    .select({
      listingId: listings.id,
      coverObjectKey: listingImages.objectKey,
      updatedAt: listings.updatedAt,
    })
    .from(listings)
    .innerJoin(
      listingImages,
      and(eq(listingImages.listingId, listings.id), eq(listingImages.sortOrder, 0)),
    )
    .leftJoin(
      listingVisualEmbeddings,
      and(
        eq(listingVisualEmbeddings.listingId, listings.id),
        eq(listingVisualEmbeddings.model, query.model),
      ),
    )
    .where(
      and(
        ...(query.afterId ? [gt(listings.id, query.afterId)] : []),
        sql`(${listingVisualEmbeddings.id} is null or ${listingVisualEmbeddings.sourceObjectKey} <> ${listingImages.objectKey})`,
      ),
    )
    .orderBy(asc(listings.id))
    .limit(query.limit)

  return rows
}
