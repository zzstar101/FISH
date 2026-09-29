import { sql } from 'drizzle-orm'
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { listings } from './listings'
import { wishes } from './wishes'

/**
 * 向量维度单点常量（#322 M1）。
 *
 * 三处必须一致：本常量、迁移里 `vector(1536)` 的 typmod、embedding provider 声明/产出的维度。
 * DB 侧靠 typmod 挡住错维写入（`expected 1536 dimensions, not N`），provider 侧在写入前
 * 自校验（`apps/worker/src/jobs/embedding/handlers.ts`），因此不存在"截断/补齐后静默入库"。
 * 换维度模型（M4）是 `ALTER TABLE ... TYPE vector(N)` + 重建，不是改这一个常量就完事。
 */
export const EMBEDDING_DIMENSIONS = 1536

/**
 * 实体文本的向量表示（#322 M1）。
 *
 * - **单表**：`listing_id` / `wish_id` 双可空 FK（各自 `ON DELETE CASCADE`），`CHECK` 保证恰有一列非空。
 *   一个实体一行/模型，M2 的两个方向（MATCH_WISH / MATCH_LISTING）因此共用同一套语义。
 * - **CASCADE 而非软删**：向量是派生数据，父实体消失后无意义（与 `matches` 同一取舍），
 *   删除父实体不需要任何清理任务，也不会留下孤儿向量。
 * - **唯一键含 `model`**：同一个实体可以同时存在新旧模型的向量，但读侧必须显式带上 `model`
 *   （见 `packages/db/src/embedding-store.ts`）——这样换模型期间不会静默混用两套向量做相似度。
 * - `content_hash` 记录**生成该向量时的文本指纹**（含文本模板版本，见
 *   `@fish/contracts/embedding/text`）：内容没变就不重复调用 provider（不重复计费），
 *   内容变了 hash 必变，job 因此能判定"需要重新生成"。
 */
export const embeddings = pgTable(
  'embeddings',
  {
    ...primaryKey(),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'cascade' }),
    wishId: uuid('wish_id').references(() => wishes.id, { onDelete: 'cascade' }),
    /** provider 自报的模型名（唯一键的一部分；不同模型的向量不可比较）。 */
    model: text('model').notNull(),
    /** provider 自报的维度；与列 typmod 一致，写错即失败（见下面的 check）。 */
    dimensions: integer('dimensions').notNull(),
    /** 生成该向量时的文本指纹（sha256 hex，含模板版本前缀）。 */
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    /**
     * 生成该向量时所读实体行的 `updated_at`——写入时的 **CAS 版本号**（#322 验收：
     * "旧 job 晚到不能覆盖新 embedding / 并发任务不得互相覆盖较新的 embedding"）。
     *
     * job 在 provider 网络调用**之前**读实体，所以一次运行携带的版本可能已经过期：
     * 实体编辑后会产生新的 EMBED_* job 并写入更高版本。`saveEmbedding` 的
     * `excluded.source_updated_at >= embeddings.source_updated_at` 条件让**晚到的旧写入
     * 整条被丢弃**（不覆盖、不报错），于是最终库里留下的一定是版本最高（最新内容）的那份向量，
     * 与两个 job 的完成顺序无关。只比 `content_hash` 做不到这一点——两份都"和自己读到的
     * 内容一致"，需要一个单调的版本才能分出先后。
     */
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps(),
  },
  (table) => [
    // 恰有一列非空：既不允许多实体共用一行，也不允许一行什么实体都不指向。
    check(
      'embeddings_exactly_one_entity',
      sql`(${table.listingId} is null) <> (${table.wishId} is null)`,
    ),
    // 冗余但刻意：typmod 挡住"向量的实际长度"，这一条挡住"记录的 dimensions 与实际列不一致"，
    // 于是 metadata 永远不会说谎（写侧漏校验时 DB 仍会失败，而不是存下一行自相矛盾的数据）。
    // `sql.raw` 不能省：迁移是**静态 SQL 文件**，`sql\`${...}\`` 里的 JS 值会被 drizzle-kit
    // 序列化成 `$1` 参数占位符（无绑定可用的迁移文件里那是语法错）。
    check(
      'embeddings_dimensions_matches_column',
      sql`${table.dimensions} = ${sql.raw(String(EMBEDDING_DIMENSIONS))}`,
    ),
    // 每个实体每个模型至多一行（partial：NULL 不参与唯一性，两列各自一条索引）。
    uniqueIndex('embeddings_listing_id_model_uq')
      .on(table.listingId, table.model)
      .where(sql`${table.listingId} is not null`),
    uniqueIndex('embeddings_wish_id_model_uq')
      .on(table.wishId, table.model)
      .where(sql`${table.wishId} is not null`),
  ],
)
