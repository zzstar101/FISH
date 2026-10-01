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
import { EMBEDDING_DIMENSIONS } from './embeddings'
import { users } from './users'

/**
 * 用户兴趣画像（#323 R2 — User Interest Profile）。
 *
 * 独立于 `embeddings` 的一张表，而不是给 `embeddings` 加一列 `user_id`：
 *
 * - `embeddings` 的语义是"某个文本实体的向量"，带 `content_hash` + `source_updated_at` 的新鲜度
 *   CAS，失效口径是"实体被编辑了"；兴趣画像是**行为聚合的派生缓存**，失效口径是"又发生了新行为"
 *   或"策略版本变了"。塞进同一张表会让两种失效规则互相污染（`embeddings` 的
 *   `exactly_one_entity` CHECK 也会被撑成三选一，读侧每次都要多带一个 `kind` 判别）。
 * - 画像**没有文本、没有 content_hash**：它不是"把用户写成一段文本再向量化"，而是
 *   `Σ(actionWeight × timeDecay × listingEmbedding) / Σ|weight|` 的算术结果（见
 *   `@fish/contracts/recommendation/interest`）。要记录的是"用了哪套权重/衰减"，即 `strategy_version`。
 *
 * 只给**登录用户**建行（R2 决策：匿名会话的长期画像不跟 anonymous_session_id 走——清存储、
 * 换设备、180 天 retention 都会让匿名身份断裂，跨会话合并会把噪声当兴趣）。匿名用户的
 * **session 画像在请求时实时计算、不落库**。
 *
 * `user_id` 用 CASCADE 而非软删：与 `embeddings` 同一取舍——画像是派生数据，父实体消失后无意义，
 * 不需要清理任务，也不会留下孤儿向量。
 */
export const userInterestProfiles = pgTable(
  'user_interest_profiles',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * 聚合时使用的 embedding 模型名。**唯一键的一部分**：换模型期间新旧画像并存，
     * 读侧必须显式带上 `model`，否则会拿旧模型的向量与新模型的商品比相似度（无意义）。
     */
    model: text('model').notNull(),
    /** provider 自报的维度；与列 typmod 一致（见下面的 check）。 */
    dimensions: integer('dimensions').notNull(),
    /** 权重/衰减/窗口口径的版本号（`INTEREST_STRATEGY_VERSION`）。版本一变，旧行即失效需重算。 */
    strategyVersion: text('strategy_version').notNull(),
    /** L2 归一化后的兴趣向量。 */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    /**
     * 真正参与聚合的行为条数（跳过的无向量/零权/下溢行为不计）。R6 用它解释
     * "这个用户的画像是几条行为撑起来的"——1 条行为的画像和 50 条的画像可信度不同。
     */
    actionCount: integer('action_count').notNull(),
    /** 本次重算的时间窗起点（长期画像 = 重算时刻 − 180 天）。 */
    windowStartedAt: timestamp('window_started_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** 本次重算完成的时刻；晚到的旧 job 用它避免把新画像写旧（见 store 的 CAS 条件）。 */
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps(),
  },
  (table) => [
    // 一行画像的存在本身就意味着"至少有一条可用行为"：没有任何可用行为时**不写行**（R2 决策，
    // 读取返回 null 让 R3 走冷启动），而不是写一行零向量。零向量与所有商品 cosine 距离相同，
    // 会把"没有画像"伪装成"有画像"。
    check('user_interest_profiles_action_count_positive', sql`${table.actionCount} >= 1`),
    // 与 `embeddings` 同款冗余校验：typmod 挡"向量实际长度"，这一条挡"记录的 dimensions 与列不一致"。
    // `sql.raw` 不能省（迁移是静态 SQL 文件，参数占位符在迁移里无绑定可用）。
    check(
      'user_interest_profiles_dimensions_matches_column',
      sql`${table.dimensions} = ${sql.raw(String(EMBEDDING_DIMENSIONS))}`,
    ),
    // 一个用户一个模型至多一行（唯一键含 model，理由同 `embeddings`）。
    uniqueIndex('user_interest_profiles_user_id_model_uq').on(table.userId, table.model),
  ],
)
