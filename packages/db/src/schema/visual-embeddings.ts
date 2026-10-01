import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps, timestamptz } from './common'
import { listings } from './listings'

/**
 * 视觉向量维度单点常量（#324 M3）。
 *
 * 与 #322 的 `EMBEDDING_DIMENSIONS = 1536` **并列而独立**：两个向量空间不可比较，
 * 共用一个常量（或共用一张表）就等于允许把图像向量和文本向量算余弦。
 *
 * 取值 1024 = `qwen3-vl-embedding` 支持的维度之一（2560/2048/1536/1024/768/512/256）。
 * 选 1024 而不是默认 2560：存储与检索成本减半，而多模态检索的任务里 1024 维足够
 * （该模型的维度是可截断的 MRL 表示）。三处必须一致：本常量、迁移里 `vector(1024)`
 * 的 typmod、provider 声明/产出的维度。
 */
export const VISUAL_EMBEDDING_DIMENSIONS = 1024

/**
 * Listing 封面图的向量表示（#324 M3/M8）。
 *
 * - **只挂 listing**：本单的检索方向是「查询图 → Listing」，与 #322 的
 *   `embeddings`（listing/wish 双实体、纯文本）是两回事，因此另开一表而不是给
 *   `embeddings` 加列——后者会立刻撞上 `vector(1536)` 的 typmod 与 `dimensions` CHECK。
 * - **一行 = 一个模型**：`(listing_id, model)` 唯一。换模型期间新旧向量并存，
 *   读侧必须显式带 `model`（见 `packages/db/src/visual-embedding-store.ts`）。
 * - `source_object_key` 是**失效判据**：生成这张向量时封面用的是哪个对象键。
 *   封面被替换 = 新的上传对象 = 新的 final key（`listing_media_objects_final_key_uq`
 *   保证 final key 与内容一一对应），所以键一变这一行就过期，不需要再存一份内容摘要。
 *   这正是 #324 要求的"封面图变了 → 视觉向量失效 → 重新生成"，而不是"文本没变就留着旧图向量"。
 * - `source_updated_at` 是写入时的 **CAS 版本号**，与 #322 `embeddings.source_updated_at`
 *   同一纪律：晚到的旧 job 不能覆盖新向量。
 * - **CASCADE 而非软删**：向量是派生数据，父实体消失后无意义。
 */
export const listingVisualEmbeddings = pgTable(
  'listing_visual_embeddings',
  {
    ...primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** provider 自报的模型名（唯一键的一部分；不同模型的向量不可比较）。 */
    model: text('model').notNull(),
    /** provider 自报的维度；与列 typmod 一致，写错即失败（见下面的 check）。 */
    dimensions: integer('dimensions').notNull(),
    /** 生成该向量时的封面对象键；与当前封面不一致即为过期（不参与召回）。 */
    sourceObjectKey: text('source_object_key').notNull(),
    /** 生成该向量时所读 Listing 行的 `updated_at`（CAS 版本号）。 */
    sourceUpdatedAt: timestamptz('source_updated_at').notNull(),
    embedding: vector('embedding', { dimensions: VISUAL_EMBEDDING_DIMENSIONS }).notNull(),
    ...timestamps(),
  },
  (table) => [
    check(
      'listing_visual_embeddings_dimensions_matches_column',
      sql`${table.dimensions} = ${sql.raw(String(VISUAL_EMBEDDING_DIMENSIONS))}`,
    ),
    // 纵深防御：查询图**永远**不能成为 Listing 向量的来源。正常路径上 `source_object_key`
    // 取自 `listing_images.object_key`（写侧只接受 `listings/…`），这条 CHECK 让"有人把
    // 上传的查询图键直接写进向量表"这条捷径在 DB 层就失败。
    check(
      'listing_visual_embeddings_source_not_query_image',
      sql`${table.sourceObjectKey} NOT LIKE 'visual-search/%'`,
    ),
    uniqueIndex('listing_visual_embeddings_listing_id_model_uq').on(table.listingId, table.model),
    // 回填/清理按 model 扫描（换模型重建时用得上）。
    index('listing_visual_embeddings_model_idx').on(table.model),
  ],
)
