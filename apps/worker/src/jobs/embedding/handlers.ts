import {
  EMBED_JOB_TYPES,
  EmbedListingJobPayloadSchema,
  EmbedWishJobPayloadSchema,
} from '@fish/contracts/embedding/jobs'
import { type EmbeddingProvider, EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
} from '@fish/contracts/embedding/text'
import type { Db } from '@fish/db/client'
import {
  type EmbeddingEntity,
  type EmbeddingExecutor,
  findEmbedding,
  saveEmbedding,
} from '@fish/db/embedding-store'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { wishes } from '@fish/db/schema/wishes'
import { eq } from 'drizzle-orm'
import { InvalidJobPayloadError } from '../invalid-payload-error'

/**
 * embedding 生成 handler（#322 M1）。
 *
 * 一次运行 = "读实体 → 构文本 → 比内容指纹 →（必要时）调 provider → 原子复检 + 写库"。
 * 五个关键点：
 * 1. **payload 只带 id，内容在运行时读**：所以晚到的旧 job 也只会拿最新内容算；"内容没变就不
 *    重复计费"由指纹比对保证。
 * 2. **provider 返回后必须原子复检内容指纹**：provider 调用期间实体可能被编辑，若拿到结果就
 *    落库，一次基于旧内容的结果会覆盖新内容的向量（#322 验收："旧 job 晚到不能覆盖新
 *    embedding / 并发任务不得互相覆盖较新的 embedding"）。复检放在**同一条事务**里，并对实体
 *    行加 `FOR UPDATE`：锁住后重读当前内容、重算指纹，只有与本次生成输入一致才允许写。锁保证
 *    "复检 → 写入"之间没有窗口，因此基于旧内容的结果永远不可能落在更新版本之后。
 * 3. **写入另带版本 CAS 作纵深防御**：`saveEmbedding` 的
 *    `excluded.source_updated_at >= embeddings.source_updated_at` 会再挡一次"版本更旧"的写入。
 *    它**不能**单独承担正确性：版本号是应用侧 `new Date()`（毫秒分辨率），同一毫秒内的两次编辑
 *    会拿到完全相同的版本号，`>=` 恒成立（详见 `packages/db/src/embedding-store.ts`）。
 * 4. **失败 fail-closed**：provider 报错、维度不符、返回非有限数值一律抛出去让队列重试/失败，
 *    绝不写一条"空向量"当成功。
 * 5. **软删除/已删实体不算失败**：实体在 job 执行前被删掉时返回 `missing` 并让 job DONE——
 *    重试也找不回来，卡在 PENDING 只会一直重试。
 */
export type EmbedRunResult = {
  entity: 'listing' | 'wish'
  /**
   * `generated` 写了新向量；`unchanged` 指纹一致未调 provider；`missing` 实体已不存在；
   * `stale` 本次结果被更新的内容取代，未写库——job 应 DONE，不需要重试。
   */
  status: 'generated' | 'unchanged' | 'stale' | 'missing'
  model: string
  contentHash: string | null
}

export type EmbedJobHandlers = {
  [EMBED_JOB_TYPES.listing]: (payload: unknown) => Promise<EmbedRunResult>
  [EMBED_JOB_TYPES.wish]: (payload: unknown) => Promise<EmbedRunResult>
}

/** 一次"读实体内容"的结果：embedding 文本（由实体字段构造）+ 读到那一刻的实体版本。 */
type EntityContent = { text: string; updatedAt: Date }

/**
 * 读实体当前内容并构造 embedding 文本。`lock` 为真时对实体行加 `FOR UPDATE`——调用方必须在
 * 事务里用它做"复检 + 写入"，否则两个并发 job 之间仍有窗口。
 */
type EntityReader = (executor: EmbeddingExecutor, lock: boolean) => Promise<EntityContent | null>

async function readListing(
  executor: EmbeddingExecutor,
  listingId: string,
  lock: boolean,
): Promise<EntityContent | null> {
  const query = executor
    .select({
      title: listings.title,
      description: listings.description,
      category: listings.category,
      updatedAt: listings.updatedAt,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)

  const rows = lock ? await query.for('update') : await query
  const row = rows[0]
  return row === undefined
    ? null
    : { text: buildListingEmbeddingText(row), updatedAt: row.updatedAt }
}

async function readWish(
  executor: EmbeddingExecutor,
  wishId: string,
  lock: boolean,
): Promise<EntityContent | null> {
  const query = executor
    .select({
      keyword: wishes.keyword,
      description: wishes.description,
      category: wishes.category,
      updatedAt: wishes.updatedAt,
    })
    .from(wishes)
    .where(eq(wishes.id, wishId))
    .limit(1)

  const rows = lock ? await query.for('update') : await query
  const row = rows[0]
  return row === undefined ? null : { text: buildWishEmbeddingText(row), updatedAt: row.updatedAt }
}

/** provider 声明与实际返回都必须是 `EMBEDDING_DIMENSIONS`：迁移里的 `vector(N)` 不认别的维度。 */
function assertDimensions(actual: number, detail: string): void {
  if (actual !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingProviderError(
      'dimension_mismatch',
      `${detail}：${actual} 维，期望 ${EMBEDDING_DIMENSIONS} 维（迁移里的 vector(${EMBEDDING_DIMENSIONS})）`,
    )
  }
}

function assertVector(vector: number[] | undefined): number[] {
  if (vector === undefined) {
    throw new EmbeddingProviderError('invalid_response', 'provider 返回的向量条数与入参不一致')
  }
  assertDimensions(vector.length, 'provider 返回的向量维度不符')
  if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    // NaN / Infinity 会让 cosine 结果变成 NaN，最终以"分数为零"的形式混进业务数据。
    throw new EmbeddingProviderError('invalid_response', 'provider 返回的向量包含非有限数值')
  }
  return vector
}

/**
 * 生成并写入一条向量；返回本次运行的结果（会作为 job 的 result 记录）。
 *
 * 版本号取的是**复检那一刻**读到的 `updated_at`：内容没变而实体版本前进了（例如只改了价格）
 * 时，向量本身仍然正确，跟着前进的版本号也不会让读侧把它误判成过期。
 */
async function generate(
  db: Db,
  provider: EmbeddingProvider,
  entity: EmbeddingEntity,
  read: EntityReader,
): Promise<EmbedRunResult> {
  assertDimensions(provider.dimensions, `provider ${provider.model} 声明的维度不符`)

  const initial = await read(db, false)
  if (initial === null) {
    return { entity: entity.kind, status: 'missing', model: provider.model, contentHash: null }
  }

  const contentHash = contentHashOf(initial.text)
  const existing = await findEmbedding(db, entity, provider.model)

  // 指纹相同且维度也一致才算"没变"：只看指纹会漏掉"同模型换了维度配置"这种异常，
  // 让一个维度错误的行永远留在库里。
  if (
    existing !== null &&
    existing.contentHash === contentHash &&
    existing.dimensions === EMBEDDING_DIMENSIONS
  ) {
    return { entity: entity.kind, status: 'unchanged', model: provider.model, contentHash }
  }

  const [vector] = await provider.embed([initial.text])
  const embedding = assertVector(vector)

  // provider 的网络调用在事务外完成（不持锁、不占连接）；事务里只做"锁实体行 → 复检指纹 → 写入"。
  const outcome = await db.transaction(async (tx) => {
    const current = await read(tx, true)
    if (current === null) return 'missing'
    if (contentHashOf(current.text) !== contentHash) return 'stale'

    const written = await saveEmbedding(tx, {
      entity,
      model: provider.model,
      dimensions: provider.dimensions,
      contentHash,
      embedding,
      sourceUpdatedAt: current.updatedAt,
    })
    return written ? 'generated' : 'stale'
  })

  return { entity: entity.kind, status: outcome, model: provider.model, contentHash }
}

export function createEmbedJobHandlers(db: Db, provider: EmbeddingProvider): EmbedJobHandlers {
  return {
    [EMBED_JOB_TYPES.listing]: async (payload) => {
      const parsed = EmbedListingJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(EMBED_JOB_TYPES.listing, parsed.error.message)
      }

      const listingId = parsed.data.listingId
      return generate(db, provider, { kind: 'listing', id: listingId }, (executor, lock) =>
        readListing(executor, listingId, lock),
      )
    },

    [EMBED_JOB_TYPES.wish]: async (payload) => {
      const parsed = EmbedWishJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(EMBED_JOB_TYPES.wish, parsed.error.message)
      }

      const wishId = parsed.data.wishId
      return generate(db, provider, { kind: 'wish', id: wishId }, (executor, lock) =>
        readWish(executor, wishId, lock),
      )
    },
  }
}
