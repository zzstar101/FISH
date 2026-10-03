import { EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import type { VisualEmbeddingProvider } from '@fish/contracts/visual/provider'
import { VISUAL_SEARCH_STRATEGY_VERSION } from '@fish/contracts/visual/ranking'
import {
  isVisualQueryImageKey,
  MAX_VISUAL_QUERY_IMAGE_BYTES,
  MAX_VISUAL_QUERY_IMAGE_PIXELS,
  VISUAL_QUERY_IMAGE_TTL_SECONDS,
  VISUAL_SOLD_AVG_MIN_SAMPLES,
  type VisualInterpretation,
  type VisualQueryImageMime,
  type VisualQueryUploadResponse,
  VisualQueryUploadResponseSchema,
  type VisualSearchErrorCode,
  type VisualSearchResponse,
  VisualSearchResponseSchema,
  type VisualSearchSort,
  type VisualSearchStats,
  visualQueryImageKey,
  visualQueryImageSubject,
} from '@fish/contracts/visual/schema'
import { newId } from '@fish/db/ids'
import { sniffImageMime } from '@fish/shared/image-mime'
import { toListingCard } from '../listings/card'
import { probeImage } from '../messages/media-probe'
import { type VisualParser, visualTextQueryOf } from './parse'
import {
  freshnessScore,
  orderVisualCandidates,
  popularityScore,
  scoreVisualCandidate,
  similarityFromCosineDistance,
  VISUAL_RECALL_LIMIT,
  VISUAL_RESULT_LIMIT,
} from './ranking'
import type { VisualSearchRateLimiter } from './rate-limit'
import type { VisualSearchStore, VisualSoldPriceStats } from './store'
import type { ResolvedVisualSearchSubject } from './subject'

/**
 * 拍照识图搜索的用例层（#324 M4/M6）。
 *
 * 一次搜索的完整链路：主体校验 → 配额 → 台账/对象二次校验（尺寸、魔术字节、像素）→
 * 图片向量化 → 两路召回 → 混合排序 → 卡片。
 *
 * ## 图片不可信的三道闸
 *
 * 客户端声明的 `contentType` / `sizeBytes` 只用于上传预检（契约 §`VisualQueryUploadRequestSchema`）。
 * 真正生效的是这里：`stat` 读对象存储里的真实大小、`sniffImageMime` 按魔术字节判定格式、
 * `probeImage` 按图片头算像素数（解压炸弹护栏：5MB 的 PNG 可以解出几十亿像素）。
 * 三者任一不过都不进入向量化——上游按图片计费，把垃圾送上去是花钱买错误。
 *
 * ## 为什么可以重复使用同一个 objectKey
 *
 * `markQueryImageUsed` 只记录"这张图被搜过"，**不**在第二次使用时拒绝：
 * 上游 503 之后客户端重试同一个 objectKey 是正常行为，如果第二次就被拒，
 * 一次上游抖动就变成用户必须重新拍一张。真正的防刷是配额（每次搜索都消耗一次）。
 */

export type VisualSearchServiceErrorStatus = 400 | 413 | 503

export class VisualSearchServiceError extends Error {
  constructor(
    readonly status: VisualSearchServiceErrorStatus,
    readonly code: VisualSearchErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'VisualSearchServiceError'
  }
}

/**
 * 本模块真正需要的存储能力，写成结构类型而不是 `Pick<MediaStorage, …>`：调用处只关心
 * "有没有这几项能力"，而不是某个具体实现类。
 *
 * `readMediaBytes` 保持与 `MediaStorage` 一致的可选写法——`createBunS3MediaStorage` 一定实现了它，
 * 但接口声明上可选，写成必选会让 `MediaStorage` 赋不进来。工厂里**一次性断言**其存在
 * （缺失即启动失败），此后按局部 const 调用，不在每个请求里重复判 `undefined`。
 */
export type VisualSearchStorage = {
  presignPut(input: { key: string; contentType: string }): {
    url: string
    headers: Record<string, string>
    expiresAt: string
  }
  stat(key: string): Promise<{ size: number; contentType: string } | null>
  readMediaBytes?(key: string, maxBytes?: number): Promise<Uint8Array | null>
  publicUrl(key: string): string
}

export type VisualSearchService = {
  createUpload(
    subject: ResolvedVisualSearchSubject,
    input: { contentType: VisualQueryImageMime; sizeBytes: number },
  ): Promise<VisualQueryUploadResponse>
  search(
    subject: ResolvedVisualSearchSubject,
    input: { objectKey: string; sort?: VisualSearchSort },
  ): Promise<VisualSearchResponse>
}

/** 声明用的 MIME → 对象键后缀。只影响 URL 观感，格式真值由搜索时的魔术字节决定。 */
const EXTENSION_BY_MIME: Record<VisualQueryImageMime, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

type SearchCandidate = {
  listingId: string
  visualScore: number
  textScore: number | null
}

/**
 * 把 store 的原始均值/样本数翻译成契约里的成交统计（#324 M6）。
 *
 * 最小样本阈值与四舍五入都锁在服务端：这是**服务端口径**，客户端不该各判一次，
 * 否则改阈值就得同时发客户端版本。样本不足时给 `null` 但**保留真实样本数**——
 * 客户端才能显示"样本不足（2 件）"，而不是一片空白。
 */
function soldPriceStatsOf(stats: VisualSoldPriceStats): VisualSearchStats {
  const tooFewSamples = stats.soldSampleCount < VISUAL_SOLD_AVG_MIN_SAMPLES
  return {
    soldAvgPriceCents:
      stats.soldAvgPriceCents === null || tooFewSamples
        ? null
        : Math.round(stats.soldAvgPriceCents),
    soldSampleCount: stats.soldSampleCount,
  }
}

export function createVisualSearchService(deps: {
  store: VisualSearchStore
  storage: VisualSearchStorage
  provider: VisualEmbeddingProvider
  parser: VisualParser
  rateLimiter: VisualSearchRateLimiter
  now?: () => Date
}): VisualSearchService {
  const { store, storage, provider, parser, rateLimiter } = deps
  const now = deps.now ?? (() => new Date())

  // "没有读字节能力"不是拍照搜图的一种可能状态：启动期就断言（接线错了当场炸），
  // 而不是把 `undefined` 带进每个搜索请求。
  const readMediaBytes = storage.readMediaBytes
  if (!readMediaBytes) {
    throw new Error('拍照搜图需要能读取对象字节的存储实现（readMediaBytes）')
  }

  /** 用户视角的错误一律用同一句话：不区分"不存在/已过期/不是你上传的"，避免变成枚举他人键的探针。 */
  function imageUnavailable(): VisualSearchServiceError {
    return new VisualSearchServiceError(
      400,
      'VISUAL_SEARCH_IMAGE_INVALID',
      '查询图不可用，请重新上传',
    )
  }

  return {
    async createUpload(subject, input) {
      await rateLimiter.consume(subject.attempts)

      const objectKey = visualQueryImageKey(
        subject.key.subjectKey,
        newId(),
        EXTENSION_BY_MIME[input.contentType],
      )
      const presigned = storage.presignPut({ key: objectKey, contentType: input.contentType })

      // 先签 URL 再落台账：反过来会在"签名失败"时留下一行永远用不到的记录。
      // 代价是"签了名但客户端没 PUT"也会留一行，由 TTL 清理兜底（这正是 TTL 存在的意义）。
      await store.registerQueryImage({
        objectKey,
        subjectType: subject.key.subjectType,
        subjectKey: subject.key.subjectKey,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        expiresAt: new Date(now().getTime() + VISUAL_QUERY_IMAGE_TTL_SECONDS * 1000),
      })

      return VisualQueryUploadResponseSchema.parse({
        objectKey,
        url: presigned.url,
        expiresAt: presigned.expiresAt,
      })
    },

    async search(subject, input) {
      await rateLimiter.consume(subject.attempts)

      // 验收「不返回本人商品」：已登录 Caller 的 userId 就是需要排除的 seller_id。
      // 匿名主体的 `subjectKey` 是会话 HMAC（不是 userId），拿它当 seller_id 比较毫无意义，
      // 所以只认 `user` 类型——匿名本来也没有"本人商品"可排除。
      const viewerId = subject.key.subjectType === 'user' ? subject.key.subjectKey : null

      // 键形状 + 归属：`visual-search/{subject}/…` 里的 subject 必须是本次请求的主体，
      // 否则用户可以引用别人上传的查询图（即使猜不到 UUID，权限也不该建立在"猜不到"上）。
      if (
        !isVisualQueryImageKey(input.objectKey) ||
        visualQueryImageSubject(input.objectKey) !== subject.key.subjectKey
      ) {
        throw imageUnavailable()
      }

      const queryImage = await store.findUsableQueryImage({
        objectKey: input.objectKey,
        subjectType: subject.key.subjectType,
        subjectKey: subject.key.subjectKey,
        now: now(),
      })
      if (!queryImage) throw imageUnavailable()

      // 以下全部按**对象存储里的真实内容**判定，客户端声明不参与。
      const stat = await storage.stat(input.objectKey)
      if (!stat) throw imageUnavailable()
      if (stat.size > MAX_VISUAL_QUERY_IMAGE_BYTES) {
        throw new VisualSearchServiceError(
          413,
          'VISUAL_SEARCH_IMAGE_TOO_LARGE',
          '查询图超过大小上限',
        )
      }

      const bytes = await readMediaBytes(input.objectKey, MAX_VISUAL_QUERY_IMAGE_BYTES)
      if (!bytes) throw imageUnavailable()
      if (bytes.length > MAX_VISUAL_QUERY_IMAGE_BYTES) {
        throw new VisualSearchServiceError(
          413,
          'VISUAL_SEARCH_IMAGE_TOO_LARGE',
          '查询图超过大小上限',
        )
      }

      const mime = sniffImageMime(bytes)
      if (!mime) throw imageUnavailable()

      const probed = probeImage(bytes, mime)
      if (!probed) throw imageUnavailable()
      if (probed.width * probed.height > MAX_VISUAL_QUERY_IMAGE_PIXELS) {
        // 按像素而不是字节设上限：解压炸弹的字节数很小，像素数才是真正的资源消耗。
        throw new VisualSearchServiceError(413, 'VISUAL_SEARCH_IMAGE_TOO_LARGE', '查询图分辨率过高')
      }

      // 记一次使用（观测用），但不因"已用过"而拒绝——见文件头注释。
      await store.markQueryImageUsed(input.objectKey)

      const visualVector = await embedImageOrUnavailable(bytes, mime)

      // 解析是可选增强，`parse` 契约上不抛（内部 fail-open 返回 null）。
      const interpretation: VisualInterpretation | null = await parser.parse(bytes, mime)

      const candidates = new Map<string, SearchCandidate>()
      for (const hit of await store.recall({
        model: provider.model,
        vector: visualVector,
        limit: VISUAL_RECALL_LIMIT,
        excludeSellerId: viewerId,
      })) {
        candidates.set(hit.listingId, {
          listingId: hit.listingId,
          visualScore: similarityFromCosineDistance(hit.distance),
          textScore: null,
        })
      }

      const textQuery = visualTextQueryOf(interpretation)
      if (textQuery) {
        // 文本路整段 fail-open：解析出的关键词只是加分项，向量化失败不该让整次搜索失败。
        // 同一个多模态模型：文本与图片在同一个向量空间里，才能拿文本向量直接比对商品封面向量。
        const textVector = await embedTextOrNull(textQuery)
        if (textVector) {
          for (const hit of await store.recall({
            model: provider.model,
            vector: textVector,
            limit: VISUAL_RECALL_LIMIT,
            excludeSellerId: viewerId,
          })) {
            const textScore = similarityFromCosineDistance(hit.distance)
            const existing = candidates.get(hit.listingId)
            if (existing) existing.textScore = textScore
            else {
              // 只被文本路召回：没有图片相似度就是没有，不拿文本分冒充 visualScore。
              candidates.set(hit.listingId, {
                listingId: hit.listingId,
                visualScore: 0,
                textScore,
              })
            }
          }
        }
      }

      if (candidates.size === 0 && !(await store.hasVisualEmbeddings(provider.model))) {
        // 与"确实没有相似商品"（200 + 空 items）分开：这里说明**回填还没跑过**，
        // 把运维/产品问题伪装成空结果会被当成"没人卖这个东西"。
        throw new VisualSearchServiceError(
          503,
          'VISUAL_SEARCH_NO_EMBEDDING',
          '视觉检索数据尚未就绪，请稍后再试',
        )
      }

      const listingIds = [...candidates.keys()]
      const category = interpretation?.category
      const [signals, listingRows, soldStats] = await Promise.all([
        store.loadListingSignals(listingIds),
        store.loadListings(listingIds),
        // 没有解析出类目就没有统计口径：不查库，直接空统计（阈值判定在服务端，客户端不重复判断）。
        category === undefined
          ? Promise.resolve<VisualSoldPriceStats>({ soldAvgPriceCents: null, soldSampleCount: 0 })
          : store.soldPriceStats(category),
      ])

      const items = orderVisualCandidates(
        listingIds.flatMap((listingId) => {
          const listing = listingRows.get(listingId)
          const signal = signals.get(listingId)
          const candidate = candidates.get(listingId)
          // 召回与取卡片之间商品可能已下架/重新待审，`loadListings` 已经再过滤一次；
          // 缺席就是"现在不可见"，直接跳过而不是给一张过期卡片。
          if (!listing || !signal || !candidate) return []

          const ranking = scoreVisualCandidate({
            visualScore: candidate.visualScore,
            textScore: candidate.textScore,
            categoryScore:
              interpretation?.category === undefined
                ? null
                : listing.category === interpretation.category
                  ? 1
                  : 0,
            freshnessScore: freshnessScore(listing.createdAt, now()),
            popularityScore: popularityScore(signal.favoriteCount),
          })

          const card = toListingCard(listing, signal.coverObjectKey, storage)
          if (!card) return []

          return [{ card, ranking, favoriteCount: signal.favoriteCount }]
        }),
        // 缺省 `relevance`：老客户端与 M9 脚本不发 sort，行为必须与 M6 之前一致。
        input.sort ?? 'relevance',
      )
        // **先排序再截断**：反过来"最新/最便宜"只会重排已截断的前 30 条，而不是全局前 30 条。
        .slice(0, VISUAL_RESULT_LIMIT)
        .map((entry) => ({ ...entry.card, favoriteCount: entry.favoriteCount }))

      return VisualSearchResponseSchema.parse({
        queryId: queryImage.id,
        interpretation,
        strategyVersion: VISUAL_SEARCH_STRATEGY_VERSION,
        embeddingModel: provider.model,
        items,
        stats: soldPriceStatsOf(soldStats),
      })
    },
  }

  async function embedImageOrUnavailable(
    bytes: Uint8Array,
    mime: VisualQueryImageMime,
  ): Promise<number[]> {
    let vector: number[]
    try {
      vector = await provider.embedImage(bytes, mime)
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        // 上游不可用必须与"没有找到相似商品"分开报（契约 §VISUAL_SEARCH_ERROR_CODES）。
        throw new VisualSearchServiceError(
          503,
          'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
          '图像识别服务暂时不可用，请稍后再试',
          error.retryable ? 5 : undefined,
        )
      }
      throw error
    }

    // provider 契约上保证维度与有限性（worker 侧各有 assert），这里再判一次是因为
    // 维度不符会让下游 `::vector` 转换整体报错，错误会以 500 的形式暴露成一个无意义的堆栈。
    if (vector.length !== provider.dimensions || !vector.every((value) => Number.isFinite(value))) {
      throw new VisualSearchServiceError(
        503,
        'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
        '图像识别服务返回了异常的向量',
      )
    }
    return vector
  }

  async function embedTextOrNull(text: string): Promise<number[] | null> {
    try {
      const vector = await provider.embedText(text)
      if (
        vector.length !== provider.dimensions ||
        !vector.every((value) => Number.isFinite(value))
      ) {
        return null
      }
      return vector
    } catch {
      // 文本路失败只降级（少一路召回），不改变整次请求的结果码。
      return null
    }
  }
}
