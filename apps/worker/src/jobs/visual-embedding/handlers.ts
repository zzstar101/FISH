/**
 * 视觉向量生成 handler（#324 M8）。
 *
 * 一次运行 = "读封面键 → 比封面键 →（必要时）读字节 → 调 provider → 事务内复检 + 写库"。
 * 与 #322 文本侧 handler（`jobs/embedding/handlers.ts`）同构，但有一处**根本分歧**：
 *
 * ## 新鲜度判据是封面对象键，不是实体版本号
 *
 * 文本向量由"标题+描述+分类"决定，所以 #322 用 `source_updated_at = 实体 updated_at` 判新鲜度，
 * 并且必须在 `unchanged` 分支把版本号推到当前（否则"改个价"就会让向量被判过期）。
 *
 * 视觉向量的输入**只有封面图**：改价、改标题、改状态都不该让向量失效。所以这里比较的是
 * `source_object_key`（见 `packages/db/src/visual-embedding-store.ts` 文件头）。三个直接后果：
 * 1. `unchanged` 分支**什么都不用写**——没有版本号要追；
 * 2. 封面被替换 = 新对象键 ⇒ 旧向量**当场**不可召回（召回侧 `source_object_key = 当前封面键`），
 *    不依赖任何失效写入，也不存在"失效窗口"；
 * 3. 并发晚到的旧 job 即使写进去也召回不出来（它的键不是当前封面键），所以这里的
 *    `FOR UPDATE` 复检是**纵深防御**而不是唯一防线。
 *
 * 失败仍然 fail-closed：provider 报错 / 维度不符 / 非有限数值一律抛出去让队列重试或失败，
 * 绝不写一条"看起来合法"的向量。**但源图本身不可用（超限、魔术字节不符）是确定性失败**：
 * 重发不会变好，所以抛 `VisualSourceImageError`，由 worker 的 `isFatalError` 判成 FAILED，
 * 让数据问题在 ops 里可见，而不是每小时重跑一次。
 */
import { EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import {
  VISUAL_EMBED_JOB_TYPES,
  VisualEmbedListingJobPayloadSchema,
} from '@fish/contracts/visual/jobs'
import type { VisualEmbeddingProvider } from '@fish/contracts/visual/provider'
import type { Db } from '@fish/db/client'
import { listingImages, listings } from '@fish/db/schema/listings'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'
import {
  findVisualEmbedding,
  saveVisualEmbedding,
  type VisualEmbeddingExecutor,
} from '@fish/db/visual-embedding-store'
import { sniffImageMime } from '@fish/shared/image-mime'
import { and, eq } from 'drizzle-orm'
import type { WorkerMediaStorage } from '../../media-storage'
import { InvalidJobPayloadError } from '../invalid-payload-error'

/** 源封面**确定性**不可用（超限 / 魔术字节不符）：重试不会变好，worker 判 fatal。 */
export class VisualSourceImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisualSourceImageError'
  }
}

export type VisualEmbedRunResult = {
  listingId: string
  /**
   * `generated` 写了新向量；`unchanged` 封面键一致未调 provider；`stale` 本次结果被更新的封面
   * 取代（未写库）；`missing` 商品已不存在；`no_cover` 商品没有封面（没有可嵌入的视觉输入）。
   * 后两者都让 job DONE——重试也找不回来。
   */
  status: 'generated' | 'unchanged' | 'stale' | 'missing' | 'no_cover'
  model: string
  sourceObjectKey: string | null
}

export type VisualEmbedJobHandlers = {
  [VISUAL_EMBED_JOB_TYPES.listing]: (payload: unknown) => Promise<VisualEmbedRunResult>
}

/** 一次"读商品视觉输入"的结果：当前封面对象键 + 读到那一刻的商品版本（只用于写入 CAS）。 */
type ListingVisualSource = { updatedAt: Date; coverObjectKey: string | null }

/**
 * 读商品当前封面键。`lock` 为真时对 **listings 行**加 `FOR UPDATE`——调用方必须在事务里用它
 * 做"复检 + 写入"。
 *
 * 封面单独查一次而不是 join：`SELECT … FROM listings LEFT JOIN listing_images … FOR UPDATE`
 * 在 Postgres 下会报 "FOR UPDATE cannot be applied to the nullable side of an outer join"，
 * 而 `FOR UPDATE OF listings` 又会把语义藏进一个不显眼的选项里。两次简单查询更直白。
 */
async function readListingVisualSource(
  executor: VisualEmbeddingExecutor,
  listingId: string,
  lock: boolean,
): Promise<ListingVisualSource | null> {
  const listingQuery = executor
    .select({ updatedAt: listings.updatedAt })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)

  const rows = lock ? await listingQuery.for('update') : await listingQuery
  const row = rows[0]
  if (row === undefined) return null

  const coverRows = await executor
    .select({ objectKey: listingImages.objectKey })
    .from(listingImages)
    .where(and(eq(listingImages.listingId, listingId), eq(listingImages.sortOrder, 0)))
    .limit(1)

  return { updatedAt: row.updatedAt, coverObjectKey: coverRows[0]?.objectKey ?? null }
}

/** provider 声明与实际返回都必须是 `VISUAL_EMBEDDING_DIMENSIONS`：迁移里的 `vector(N)` 不认别的维度。 */
function assertDimensions(actual: number, detail: string): void {
  if (actual !== VISUAL_EMBEDDING_DIMENSIONS) {
    throw new EmbeddingProviderError(
      'dimension_mismatch',
      `${detail}：${actual} 维，期望 ${VISUAL_EMBEDDING_DIMENSIONS} 维（迁移里的 vector(${VISUAL_EMBEDDING_DIMENSIONS})）`,
    )
  }
}

function assertVector(vector: number[]): number[] {
  assertDimensions(vector.length, 'provider 返回的向量维度不符')
  if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    // NaN / Infinity 会让 cosine 变成 NaN，最后以"分数为零"的形式混进排序结果。
    throw new EmbeddingProviderError('invalid_response', 'provider 返回的向量包含非有限数值')
  }
  return vector
}

async function generate(
  db: Db,
  provider: VisualEmbeddingProvider,
  storage: WorkerMediaStorage,
  listingId: string,
): Promise<VisualEmbedRunResult> {
  assertDimensions(provider.dimensions, `provider ${provider.model} 声明的维度不符`)

  const initial = await readListingVisualSource(db, listingId, false)
  if (initial === null) {
    return { listingId, status: 'missing', model: provider.model, sourceObjectKey: null }
  }
  if (initial.coverObjectKey === null) {
    return { listingId, status: 'no_cover', model: provider.model, sourceObjectKey: null }
  }

  const existing = await findVisualEmbedding(db, listingId, provider.model)
  // 键一致 + 维度一致才算"没变"：只看键会漏掉"同模型换了维度配置"这种异常，
  // 让一个维度错误的行永远留在库里。
  if (
    existing !== null &&
    existing.sourceObjectKey === initial.coverObjectKey &&
    existing.dimensions === VISUAL_EMBEDDING_DIMENSIONS
  ) {
    return {
      listingId,
      status: 'unchanged',
      model: provider.model,
      sourceObjectKey: initial.coverObjectKey,
    }
  }

  const bytes = await storage.readBytes(initial.coverObjectKey, MAX_IMAGE_BYTES)
  if (bytes === null) {
    // 读不到当作可重试：S3 抖动是暂时的，队列重试即可；商品被删/封面被删会走上面的分支。
    throw new EmbeddingProviderError('network', `封面对象读取失败（${initial.coverObjectKey}）`)
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new VisualSourceImageError(
      `封面超过 ${MAX_IMAGE_BYTES} 字节上限（${initial.coverObjectKey}）`,
    )
  }
  const mime = sniffImageMime(bytes)
  if (mime === null) {
    throw new VisualSourceImageError(
      `封面魔术字节不是受支持的图片格式（${initial.coverObjectKey}）`,
    )
  }

  // provider 的网络调用在事务外完成（不持锁、不占连接）；事务里只做"锁商品行 → 复检封面键 → 写入"。
  const embedding = assertVector(await provider.embedImage(bytes, mime))

  // 收窄成局部 const 再进闭包：TS 不对 `db.transaction(async () => …)` 闭包里的属性访问保持
  // `initial.coverObjectKey` 的非空收窄（`initial` 被闭包捕获后属性访问退回 `string | null`）。
  const sourceObjectKey = initial.coverObjectKey

  const outcome = await db.transaction(async (tx) => {
    const current = await readListingVisualSource(tx, listingId, true)
    if (current === null) return 'missing'
    if (current.coverObjectKey !== initial.coverObjectKey) return 'stale'

    const written = await saveVisualEmbedding(tx, {
      listingId,
      model: provider.model,
      dimensions: provider.dimensions,
      sourceObjectKey,
      embedding,
      sourceUpdatedAt: current.updatedAt,
    })
    return written ? 'generated' : 'stale'
  })

  return {
    listingId,
    status: outcome,
    model: provider.model,
    sourceObjectKey: initial.coverObjectKey,
  }
}

export function createVisualEmbedJobHandlers(
  db: Db,
  provider: VisualEmbeddingProvider,
  storage: WorkerMediaStorage,
): VisualEmbedJobHandlers {
  return {
    [VISUAL_EMBED_JOB_TYPES.listing]: async (payload) => {
      const parsed = VisualEmbedListingJobPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new InvalidJobPayloadError(VISUAL_EMBED_JOB_TYPES.listing, parsed.error.message)
      }

      return generate(db, provider, storage, parsed.data.listingId)
    },
  }
}
