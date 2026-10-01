import { and, asc, eq, inArray, lt, ne, type SQL, sql } from 'drizzle-orm'
import type { Db } from './client'
import { newId } from './ids'
import { embeddings } from './schema/embeddings'
import { listings } from './schema/listings'
import { wishes } from './schema/wishes'

/**
 * 向量行的读写（#322 M1）。
 *
 * 只做"取一行 / 落一行"，**不构造文本、不调用 provider、不判失效**——那些在
 * `@fish/contracts/embedding/text`（文本与内容指纹）与
 * `apps/worker/src/jobs/embedding/handlers.ts`（生成决策）里。这样 M2 的召回与 M4 的
 * backfill 可以复用同一存取层，而不必各自再写一遍 SQL。
 *
 * ## 新鲜度不变量（#322 M2/M3，评审 blocker 修复）
 *
 * **只有"对应当前实体版本"的向量才允许进入召回与打分。** 候选侧用
 * `embeddings.source_updated_at = 实体当前 updated_at` 作为判据（下面两条 `fresh*` 谓词）：
 *
 * - 实体被编辑后、`EMBED_*` 还没跑完（或失败）时，旧向量不满足等式 ⇒ **不进 Top-K**
 *   （不占 K 名额），也不会被按 id 补算拿去做 hybrid 打分 ⇒ 这一对退回 v1 口径。
 *   否则会把"旧向量"和"当前的价格/分类事实"拼成一个混合版本的分，甚至让过期候选挤掉
 *   真正相关的新鲜候选——这正是评审指出的问题。
 * - 内容没变但实体版本前进（改价、改状态这类不碰 embedding 文本的编辑）由 handler 的
 *   `refreshEmbeddingSourceVersion` 推进标记，因此合法向量不会被误判成过期。
 *
 * 目标侧（`findEmbedding` 的调用方）用更精确的判据：直接把 `content_hash` 与当前文本指纹比
 * （引擎在那里本来就要构文本）。候选侧没法在 SQL 里逐行算文本指纹，才用版本标记这个等价代理；
 * 两者的共同含义都是"这条向量是不是对应当前内容"。
 */

/** 向量指向的实体。单表双可空 FK，所以"哪个实体"必须是显式参数（见 `schema/embeddings.ts`）。 */
export type EmbeddingEntity = { kind: 'listing'; id: string } | { kind: 'wish'; id: string }

/**
 * 只声明本模块真正用到的方法：这样 `Db` 与 `db.transaction(tx => ...)` 里的 `tx` 都能直接传进来。
 * 调用方需要在**同一条事务**里完成"复检实体内容 + 落向量"，所以执行器必须是可替换的。
 */
export type EmbeddingExecutor = Pick<Db, 'select' | 'insert'>

/** 一行向量（不含指向哪个实体——调用方本来就知道自己查的是谁）。 */
export type EmbeddingRow = {
  model: string
  dimensions: number
  contentHash: string
  embedding: number[]
  /** 生成该向量时所读实体行的 `updated_at`，写入 CAS 的版本号（见 `schema/embeddings.ts`）。 */
  sourceUpdatedAt: Date
}

export type SaveEmbeddingInput = {
  entity: EmbeddingEntity
  model: string
  dimensions: number
  contentHash: string
  embedding: number[]
  /**
   * 本次生成所依据的实体版本（读实体那一刻的 `updated_at`）。
   * 只有它 **不低于** 库里已有行的版本时写入才会生效，否则整条写入被丢弃。
   */
  sourceUpdatedAt: Date
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
  executor: Pick<Db, 'select'>,
  entity: EmbeddingEntity,
  model: string,
): Promise<EmbeddingRow | null> {
  const rows = await executor
    .select({
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      contentHash: embeddings.contentHash,
      embedding: embeddings.embedding,
      sourceUpdatedAt: embeddings.sourceUpdatedAt,
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
 *
 * **带版本的 CAS**（#322 验收："旧 job 晚到不能覆盖新 embedding"）：`ON CONFLICT DO UPDATE`
 * 上带 `WHERE excluded.source_updated_at >= embeddings.source_updated_at`，因此一次**基于旧内容**
 * 的写入（在 provider 上卡住期间实体被编辑过）即使晚到也会被整条丢弃，不会把新向量改回旧的。
 * 返回值就是"这次到底写没写进去"：`false` 表示被更新的版本抢先，调用方必须当成"本次结果作废"
 * （handler 记为 `stale`），而不是当成写入成功。
 *
 * **但这层 CAS 不是"旧 job 永不覆盖新 embedding"的充分条件**（#328 复审 blocker）：版本号来自
 * 应用侧 `new Date()`（JS `Date` 只有**毫秒**分辨率），同一毫秒内的两次内容更新会拿到**完全相同**
 * 的版本号，此时 `excluded >= embeddings` 恒成立，晚到的旧写入照样能覆盖新内容。把条件改成
 * 严格 `>` 也不对——同一毫秒的**新**内容反而会写不进去。真正的先后判定必须靠"内容指纹是否仍是
 * 当前内容"，由调用方在**同一条事务里锁住实体行**复检（见
 * `apps/worker/src/jobs/embedding/handlers.ts` 的原子复检）。这里的 CAS 保留作纵深防御：
 * 它能挡住"版本明显更旧"的写入，且是幂等重写的天然护栏。
 */
export async function saveEmbedding(
  executor: Pick<Db, 'insert'>,
  input: SaveEmbeddingInput,
): Promise<boolean> {
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
    sourceUpdatedAt: input.sourceUpdatedAt,
  }

  // `updated_at` 必须显式写：`$onUpdate` 只挂在 drizzle 的 `.update()` 上，onConflict 的
  // `set` 走的是原始 insert 路径（与 `apps/worker/src/jobs/queue.ts` 的 settle 同一注意点）。
  const patch = {
    dimensions: input.dimensions,
    contentHash: input.contentHash,
    embedding: input.embedding,
    sourceUpdatedAt: input.sourceUpdatedAt,
    updatedAt: new Date(),
  }

  // CAS 条件里必须用 `excluded`（本次要写入的那一行）与目标表列比较：`DO UPDATE ... WHERE`
  // 为假时 PG 既不写也不报错，只是不返回行——这正是"旧写入被静默丢弃"的语义。
  const setWhere = sql`excluded."source_updated_at" >= ${embeddings.sourceUpdatedAt}`

  // 冲突目标必须带 partial index 的谓词，否则 PG 无法把 (col, model) 推断到那条 partial
  // unique index 上（两条 partial 索引的形状相同，只差哪一列非空）。
  if (listingId !== null) {
    const rows = await executor
      .insert(embeddings)
      .values(values)
      .onConflictDoUpdate({
        target: [embeddings.listingId, embeddings.model],
        targetWhere: sql`${embeddings.listingId} is not null`,
        set: patch,
        setWhere,
      })
      .returning({ id: embeddings.id })
    return rows.length > 0
  }

  const rows = await executor
    .insert(embeddings)
    .values(values)
    .onConflictDoUpdate({
      target: [embeddings.wishId, embeddings.model],
      targetWhere: sql`${embeddings.wishId} is not null`,
      set: patch,
      setWhere,
    })
    .returning({ id: embeddings.id })
  return rows.length > 0
}

/**
 * 该实体是否存在**别的模型**的向量（#322 M2，只判存在、不读向量）。
 *
 * 用途只有一个：把"从来没有生成本模型的向量"（`missing`）与"有向量但属于旧模型、需要 backfill"
 * （`model-mismatch`）区分开。两者对召回都是"不可用"，但成因不同——线上排障与 M4 的换模型重建
 * 都要能看出来。**不取那行向量**：混用不同模型的向量算相似度正是 #322 禁止的事。
 */
export async function hasEmbeddingFromOtherModel(
  db: Db,
  entity: EmbeddingEntity,
  model: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: embeddings.id })
    .from(embeddings)
    .where(and(entityFilter(entity), ne(embeddings.model, model)))
    .limit(1)

  return rows.length > 0
}

/**
 * 内容一变就让旧向量立即不可召回（#333 复审 blocker 的**主判据**）。
 *
 * **为什么不能用时间戳证明新鲜**：实体 `updated_at` 由应用侧 `new Date()` 写入（毫秒分辨率），
 * 同一毫秒内的两次编辑会得到完全相同的版本号——#328 的并发用例已经证明"不同内容可以有相同的
 * `updatedAt`"。时间戳相等推不出内容相同，所以候选侧需要一个**按内容**的判据。
 *
 * 判据就是 `content_hash`：调用方（写路径）在**同一事务**里用新内容重算指纹，然后删掉该实体下
 * 指纹不同的所有向量行。理由：
 *   - 那些行描述的是**已经不存在的内容**，留着只会被召回、被打分（M3 还会拿旧 cosine 与当前
 *     结构事实混算出"当前结构 + 旧语义"的分数）；
 *   - 删除是"立即失效"，不取决于 worker 什么时候跑到 EMBED_* job；
 *   - 不软标记（不加 `invalidated_at` 之类的新列）：EMBED_* job 会重建，旧向量没有任何保留价值。
 *
 * 指纹一致的行**不动**：只改价格/状态这类不进 embedding 文本的编辑走 handler 的 `unchanged`
 * 分支（`refreshEmbeddingSourceVersion`），不会重复调用 provider（"内容不变不重复计费"）。
 *
 * 返回被删掉的行数（0 = 本来就没有旧内容向量，或内容没变）。
 */
export async function pruneStaleEmbeddings(
  executor: Pick<Db, 'delete'>,
  input: { entity: EmbeddingEntity; contentHash: string },
): Promise<number> {
  const rows = await executor
    .delete(embeddings)
    .where(and(entityFilter(input.entity), ne(embeddings.contentHash, input.contentHash)))
    .returning({ id: embeddings.id })

  return rows.length
}

/**
 * 候选向量新鲜度谓词（#322 M2 复审 blocker）——**纵深防御**，不是主判据。
 *
 * 主判据是写路径的 `pruneStaleEmbeddings()`：实体内容一变，同一事务里就把指纹不符的向量行删掉，
 * 于是"行还在"本身就意味着它对应的是当前内容（按内容证明，与时间戳精度无关）。
 *
 * 这里再比一次 `source_updated_at`，是为了兜住"某个写路径忘了调 prune"的情形：那种情况下旧行的
 * 版本号仍停在编辑前，只要编辑落在**不同的毫秒**就会被挡掉。它是补充，不能单独承担正确性
 * （同一毫秒内两次编辑的版本号相同，见 #328）。
 *
 * 不新鲜的候选**必须从语义召回里排除**，而不是取进来再在 JS 层降级：否则它会占掉 Top-K 名额，
 * 把真正新鲜的候选挤出去（#322 "existing match 掉出 Top K 后能降级" 的前提是候选集合本身正确），
 * 而且 M3 会拿这个旧 cosine 直接进 hybrid 打分，得到"当前结构事实 + 旧语义"的混合分。
 *
 * 比较**必须按毫秒截断**：实体 `updated_at` 由 `now()` 写入（微秒精度），而版本号经应用侧
 * `Date`（毫秒）往返——handler 写 `source_updated_at` 时已被截断。直接等值比较会让几乎所有向量
 * 都判定为过期（只有恰好落在毫秒边界上才相等）。
 *
 * #323 R2 的兴趣聚合用的是同一套判据，但它必须**逐行**在 JS 里判（见 `user-interest-store.ts`：
 * 只有逐行比较才能把"向量过期"与"根本没向量"分开计数），所以这里仍是本文件私有。
 */
function freshListingsEmbedding(): SQL {
  return sql`date_trunc('milliseconds', ${embeddings.sourceUpdatedAt}) = date_trunc('milliseconds', ${listings.updatedAt})`
}

function freshWishesEmbedding(): SQL {
  return sql`date_trunc('milliseconds', ${embeddings.sourceUpdatedAt}) = date_trunc('milliseconds', ${wishes.updatedAt})`
}

/** 一条语义召回候选：`distance` 是 cosine **距离**（0 = 同向、1 = 正交、2 = 反向）。 */
export type SimilarCandidate = { id: string; distance: number }

export type SimilarQuery = {
  /** 必须显式给出：不同模型的向量不可比较（见上面的 `findEmbedding`）。 */
  model: string
  /** 查询向量（目标实体的向量）。 */
  vector: number[]
  /** 取前几条。 */
  limit: number
  /**
   * 结构化收窄条件（由引擎构造的 SQL 片段，两个方向各自的规则）。
   *
   * **必须带**：召回是在"结构化过滤后的集合"里排序取 Top-K，而不是先全域取 Top-K 再过滤——
   * 后者会让被价格/分类/状态挡掉的候选挤掉合法候选（也违背"C 结构化规则继续做硬约束"）。
   */
  filter?: SQL
}

/**
 * 语义召回（#322 M2）：与目标**愿望**最相近的前 `limit` 条商品。
 *
 * 两个方向共用同一套语义定义：同一个 `model`、同一个距离算子（`<=>`）、同一个 Top-K 常量、
 * 同一份结构化收窄规则（由调用方以 `filter` 传入），只有"候选是哪张表"不同。
 *
 * 只返回 `{id, distance}`：打分需要的是完整实体行，而 Top-K 只需要 id 与顺序。让调用方按 id
 * 再取一遍实体（而不是在这里宽表 join 出打分字段），是为了让"召回"与"打分输入"各自只有一处
 * 投影定义——见 `engine.ts` 里两个方向的 `*Columns`。
 *
 * 不建 ANN 索引（M2 实测数据量下 exact scan 足够，见 M2 设计文档 §6）：本函数就是一次
 * `ORDER BY embedding <=> $1 LIMIT K` 的全表 exact 扫描。
 *
 * **只召回新鲜向量**：`freshListingsEmbedding()` 把"实体编辑后还没重算向量"的候选挡在
 * Top-K 之外——它们既不占 K 名额，也不会被送去 hybrid 打分（评审 blocker 修复）。
 */
export async function topKSimilarListings(
  db: Db,
  query: SimilarQuery,
): Promise<SimilarCandidate[]> {
  const vector = JSON.stringify(query.vector)

  return (
    db
      .select({
        id: listings.id,
        distance: sql<number>`${embeddings.embedding} <=> ${vector}::vector`,
      })
      .from(embeddings)
      .innerJoin(listings, eq(listings.id, embeddings.listingId))
      .where(and(eq(embeddings.model, query.model), freshListingsEmbedding(), query.filter))
      // 距离并列时用 `id` 兜底：`<=>` 只有一个排序键，并列的行谁进 Top-K 会取决于物理返回顺序，
      // 于是"同输入 ⇒ 同候选集"（#323 验收项 9）在并列边界上不成立。加上次键后 LIMIT K 的结果
      // 由数据决定，与插入顺序 / 页填充 / vacuum 时机无关。
      .orderBy(sql`${embeddings.embedding} <=> ${vector}::vector`, asc(listings.id))
      .limit(query.limit)
  )
}

/** 语义召回：与目标**商品**最相近的前 `limit` 条愿望（`topKSimilarListings` 的镜像）。 */
export async function topKSimilarWishes(db: Db, query: SimilarQuery): Promise<SimilarCandidate[]> {
  const vector = JSON.stringify(query.vector)

  return db
    .select({
      id: wishes.id,
      distance: sql<number>`${embeddings.embedding} <=> ${vector}::vector`,
    })
    .from(embeddings)
    .innerJoin(wishes, eq(wishes.id, embeddings.wishId))
    .where(and(eq(embeddings.model, query.model), freshWishesEmbedding(), query.filter))
    .orderBy(sql`${embeddings.embedding} <=> ${vector}::vector`)
    .limit(query.limit)
}

/**
 * 按 id **精确补算**向量相似度（#322 M3）：给"union 进来的已有 `matches` 行"用。
 *
 * 评估集合 = 新 Top-K ∪ 该 target 已有 matches（#322 契约），落选的已有行**不在 Top-K 里**，
 * 因此必须单独取一次相似度：否则这些对拿不到 cosine，只能退回 v1 打分，于是"召回状态变化"
 * 会被误读成"匹配质量变化"，出现了同一对在两种状态下两套分数的假降级。
 *
 * 无 `LIMIT`（行数就是该 target 的已有匹配数，量级个位到几十），也没有结构化过滤——
 * 已有行的存在本身就说明它曾经通过过结构化规则，这里要的是"这一对现在多少分"。
 *
 * **但新鲜度一样要查**：已有行如果指向的是过期向量，就不能把旧 cosine 当 ranking v2 的真值
 * （那会给出"当前结构事实 + 旧语义"的混合分）。查不到就当作这一对没有语义分，按 v1 口径重算。
 */
export type SimilarByIdsQuery = {
  /** 必须显式给出，与 `topKSimilar*` 同一口径。 */
  model: string
  vector: number[]
  /** 待补算的候选 id（空数组直接返回空，不发 SQL）。 */
  ids: string[]
}

export async function similarListingsByIds(
  db: Db,
  query: SimilarByIdsQuery,
): Promise<SimilarCandidate[]> {
  if (query.ids.length === 0) return []
  const vector = JSON.stringify(query.vector)

  return db
    .select({
      id: listings.id,
      distance: sql<number>`${embeddings.embedding} <=> ${vector}::vector`,
    })
    .from(embeddings)
    .innerJoin(listings, eq(listings.id, embeddings.listingId))
    .where(
      and(
        eq(embeddings.model, query.model),
        freshListingsEmbedding(),
        inArray(embeddings.listingId, query.ids),
      ),
    )
}

/** `similarListingsByIds` 的镜像（愿望侧）。 */
export async function similarWishesByIds(
  db: Db,
  query: SimilarByIdsQuery,
): Promise<SimilarCandidate[]> {
  if (query.ids.length === 0) return []
  const vector = JSON.stringify(query.vector)

  return db
    .select({
      id: wishes.id,
      distance: sql<number>`${embeddings.embedding} <=> ${vector}::vector`,
    })
    .from(embeddings)
    .innerJoin(wishes, eq(wishes.id, embeddings.wishId))
    .where(
      and(
        eq(embeddings.model, query.model),
        freshWishesEmbedding(),
        inArray(embeddings.wishId, query.ids),
      ),
    )
}

/**
 * 把一条**内容仍然对得上**的向量行的版本标记推进到实体当前版本。
 *
 * 用在 handler 的 `unchanged` 分支：内容指纹一致 ⇒ 不必重算向量、不必重新计费，但实体版本可能
 * 已经前进（改价、改状态、改图片这类不碰 embedding 文本的编辑）。不推进标记，这条向量就会被
 * 上面的新鲜度谓词误判成过期：候选侧从此进不了 Top-K，等于"改个价就再也匹配不上"。
 *
 * 两个守卫保证它只能"把仍然正确的向量标记为当前版本"，永远不会把旧向量写成新的：
 * - `content_hash = 本次内容指纹`：向量对得上当前内容才允许推进；
 * - `source_updated_at < 当前实体版本`：只前进不回退（并发下晚到的旧 job 不会把标记拉回去）。
 *
 * 返回是否真的推进了；没有可推进的行时返回 `false`（不是错误，`unchanged` 仍然是成功）。
 */
export type RefreshEmbeddingVersionInput = {
  entity: EmbeddingEntity
  model: string
  /** 本次按实体当前内容算出的指纹（必须与库里的行一致才允许推进）。 */
  contentHash: string
  /** 读实体那一刻的版本（`updated_at`）。 */
  sourceUpdatedAt: Date
}

export async function refreshEmbeddingSourceVersion(
  db: Db,
  input: RefreshEmbeddingVersionInput,
): Promise<boolean> {
  const rows = await db
    .update(embeddings)
    .set({ sourceUpdatedAt: input.sourceUpdatedAt, updatedAt: new Date() })
    .where(
      and(
        entityFilter(input.entity),
        eq(embeddings.model, input.model),
        eq(embeddings.contentHash, input.contentHash),
        lt(embeddings.sourceUpdatedAt, input.sourceUpdatedAt),
      ),
    )
    .returning({ id: embeddings.id })

  return rows.length > 0
}
