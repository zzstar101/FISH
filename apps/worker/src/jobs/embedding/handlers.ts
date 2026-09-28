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
import { type EmbeddingEntity, findEmbedding, saveEmbedding } from '@fish/db/embedding-store'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { wishes } from '@fish/db/schema/wishes'
import { eq } from 'drizzle-orm'
import { InvalidJobPayloadError } from '../invalid-payload-error'

/**
 * embedding 生成 handler（#322 M1）。
 *
 * 一次运行 = "读实体（连同它的 `updated_at` 版本）→ 构文本 → 比内容指纹 →（必要时）调 provider
 * → 带 CAS 写库"。四个关键点：
 * 1. **payload 只带 id，内容在运行时读**：所以晚到的旧 job 也只会拿最新内容算；"内容没变就不
 *    重复计费"由指纹比对保证。
 * 2. **写入带版本 CAS**：向量落库时带上"读实体那一刻的 `updated_at`"，由 `saveEmbedding` 的
 *    `excluded.source_updated_at >= embeddings.source_updated_at` 决定是否生效。若 provider 调用
 *    期间实体被编辑、新 job 已写入新向量，这次**基于旧内容**的写入会被整条丢弃并返回 `stale`
 *    （#322 验收："旧 job 晚到不能覆盖新 embedding"）。只比 content_hash 做不到——两份写入
 *    都和各自读到的内容一致，必须靠单调版本分先后。
 * 3. **失败 fail-closed**：provider 报错、维度不符、返回非有限数值一律抛出去让队列重试/失败，
 *    绝不写一条"空向量"当成功。
 * 4. **软删除/已删实体不算失败**：实体在 job 执行前被删掉时返回 `missing` 并让 job DONE——
 *    重试也找不回来，卡在 PENDING 只会一直重试。
 */
export type EmbedRunResult = {
  entity: 'listing' | 'wish'
  /**
   * `generated` 写了新向量；`unchanged` 指纹一致未调 provider；`missing` 实体已不存在；
   * `stale` 本次结果被更高版本（更新的内容）取代，未写库——job 应 DONE，不需要重试。
   */
  status: 'generated' | 'unchanged' | 'stale' | 'missing'
  model: string
  contentHash: string | null
}

export type EmbedJobHandlers = {
  [EMBED_JOB_TYPES.listing]: (payload: unknown) => Promise<EmbedRunResult>
  [EMBED_JOB_TYPES.wish]: (payload: unknown) => Promise<EmbedRunResult>
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
 * `sourceUpdatedAt` 是读实体那一刻的版本，原样带进写入条件（见 `saveEmbedding`）。
 */
async function generate(
  db: Db,
  provider: EmbeddingProvider,
  entity: EmbeddingEntity,
  text: string,
  sourceUpdatedAt: Date,
): Promise<EmbedRunResult> {
  assertDimensions(provider.dimensions, `provider ${provider.model} 声明的维度不符`)

  const contentHash = contentHashOf(text)
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

  const [vector] = await provider.embed([text])
  const written = await saveEmbedding(db, {
    entity,
    model: provider.model,
    dimensions: provider.dimensions,
    contentHash,
    embedding: assertVector(vector),
    sourceUpdatedAt,
  })

  return {
    entity: entity.kind,
    status: written ? 'generated' : 'stale',
    model: provider.model,
    contentHash,
  }
}

export function createEmbedJobHandlers(db: Db, provider: EmbeddingProvider): EmbedJobHandlers {
  return {
    [EMBED_JOB_TYPES.listing]: async (payload) => {
      const parsed = EmbedListingJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(EMBED_JOB_TYPES.listing, parsed.error.message)
      }

      const rows = await db
        .select({
          title: listings.title,
          description: listings.description,
          category: listings.category,
          updatedAt: listings.updatedAt,
        })
        .from(listings)
        .where(eq(listings.id, parsed.data.listingId))
        .limit(1)

      const listing = rows[0]
      if (!listing) {
        return {
          entity: 'listing',
          status: 'missing',
          model: provider.model,
          contentHash: null,
        }
      }

      return generate(
        db,
        provider,
        { kind: 'listing', id: parsed.data.listingId },
        buildListingEmbeddingText(listing),
        listing.updatedAt,
      )
    },

    [EMBED_JOB_TYPES.wish]: async (payload) => {
      const parsed = EmbedWishJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(EMBED_JOB_TYPES.wish, parsed.error.message)
      }

      const rows = await db
        .select({
          keyword: wishes.keyword,
          description: wishes.description,
          category: wishes.category,
          updatedAt: wishes.updatedAt,
        })
        .from(wishes)
        .where(eq(wishes.id, parsed.data.wishId))
        .limit(1)

      const wish = rows[0]
      if (!wish) {
        return { entity: 'wish', status: 'missing', model: provider.model, contentHash: null }
      }

      return generate(
        db,
        provider,
        { kind: 'wish', id: parsed.data.wishId },
        buildWishEmbeddingText(wish),
        wish.updatedAt,
      )
    },
  }
}
