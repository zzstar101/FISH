import { createHash } from 'node:crypto'
import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import type {
  ReviewMediaConfirmRequest,
  ReviewMediaConfirmResponse,
  ReviewMediaPresignRequest,
  ReviewMediaPresignResponse,
} from '@fish/contracts/transaction-reviews/schema'
import { newId } from '@fish/db/ids'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createLocalContentModerationProvider } from '../moderation/providers/local'
import type { LoadModerationImage } from '../moderation/providers/tencent'
import {
  ContentModerationError,
  type ContentModerationProvider,
} from '../moderation/providers/types'
import { createTokenBucketLimiter } from '../recommendation/rate-limit'
import { reviewModerationMediaPrefix } from '../uploads/review-media'
import type { MediaStorage } from '../uploads/storage'
import {
  isReviewMediaStagingKey,
  reviewMediaPublicPrefix,
  reviewMediaStagingPrefix,
} from '../uploads/storage'
import {
  effectiveReviewModerationDecision,
  type ReviewModerationRow,
  type ReviewModerationStore,
} from './moderation-store'

/**
 * 评价配图上传链（#475，审核闭环 #694 M5c）：presign（签 staging）→ 客户端直传 →
 * confirm（读真实字节 → IMS → 按结论固化 final）。
 *
 * 与 listing 的上传链同形，但**审核后的落点不同**：
 * - ALLOW → `reviews/{usr_…}/{med_…}.ext`（公开代理读）；
 * - REVIEW → `review-moderation-media/{usr_…}/{med_…}.ext`（私有，仅本人/管理员可读，进人工队列）；
 * - BLOCK → 不写任何 final 键，删 staging，返回 422 `REVIEW_IMAGE_BLOCKED`。
 *
 * 防 TOCTOU 的根据是「只审一次、只固化同一份字节」：confirm 全量读一次 staging，算 sha256，
 * 让 provider 的 loadImage 回放**这次读到的**字节（不重读对象存储），再比较腾讯 `FileMD5`
 * 与本地 md5。落库的摘要/大小/结论与固化的 final 对象绑定；之后 staging 被覆盖也改不掉 final
 * （条件写不覆盖；重放走审核台账而不是重跑 IMS）。
 *
 * 幂等：唯一键 `(user_id, staging_key, content_digest)` 是并发 confirm 的仲裁点；输家读赢家
 * 那一行返回同一结论。同一 staging 键换了字节再 confirm 时，final 已存在且摘要不同 →
 * 显式 422（已固化的图不可被替换）。
 */

export class ReviewMediaServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 429 | 503,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[],
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ReviewMediaServiceError'
  }
}

const transactionNotFound = () =>
  new ReviewMediaServiceError(404, 'TRANSACTION_NOT_FOUND', '交易不存在')
const notCompleted = () =>
  new ReviewMediaServiceError(409, 'TRANSACTION_NOT_COMPLETED', '交易完成后才能评价')
const reviewExists = () =>
  new ReviewMediaServiceError(409, 'TRANSACTION_REVIEW_EXISTS', '这笔交易你已经评价过了')
const rateLimited = (retryAfterSeconds: number) =>
  new ReviewMediaServiceError(
    429,
    'REVIEW_MEDIA_RATE_LIMITED',
    '上传过于频繁，请稍后再试',
    undefined,
    Math.max(1, Math.ceil(retryAfterSeconds)),
  )

/**
 * 存储缺少读取/固化能力 = 配置缺失（不是用户输入问题）：**显式 503**，不要用可选链把
 * 它静默降级成「图片不可引用」（会把配置错误伪装成 422）或「假成功」（写不出 final 对象
 * 却返回一个不存在的键）。listing 上传链在同一位置是同一取舍。
 */
const storageUnavailable = () =>
  new ReviewMediaServiceError(503, 'REVIEW_MEDIA_UNAVAILABLE', '图片上传暂时不可用，请稍后重试')

const moderationUnavailable = () =>
  new ReviewMediaServiceError(
    503,
    'CONTENT_MODERATION_UNAVAILABLE',
    '内容审核暂时不可用，请稍后重试',
  )

const invalidKey = () =>
  new ReviewMediaServiceError(422, 'REVIEW_IMAGE_INVALID', '图片对象不可引用，请重新上传', [
    { field: 'objectKey', message: '图片对象不可引用' },
  ])

const imageBlocked = () =>
  new ReviewMediaServiceError(422, 'REVIEW_IMAGE_BLOCKED', '图片未通过内容审核，请更换后重新上传', [
    { field: 'objectKey', message: '图片未通过内容审核' },
  ])

const EXTENSION_BY_MIME: Record<(typeof ALLOWED_IMAGE_MIME)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const ALLOWED_MIME = new Set<string>(ALLOWED_IMAGE_MIME)

/** 真实图片的魔数判据（不看扩展名、不看客户端声明；与三档允许 MIME 一一对应）。 */
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp'
  }
  return null
}

/** presign/confirm 共用的门（与评价边 POST 一致：参与者 → COMPLETED → 尚未评价）。 */
export interface ReviewMediaGate {
  /**
   * 返回 `null` = 不是参与者/交易不存在（404）；否则给出**内部交易 id**（审核记录外键）、
   * 状态与「我是否已评价」。
   */
  transactionGate(
    transactionId: string,
    userId: string,
  ): Promise<{ id: string; status: string; hasReview: boolean } | null>
}

export interface ReviewMediaService {
  presign(
    userId: string,
    transactionId: string,
    input: ReviewMediaPresignRequest,
  ): Promise<ReviewMediaPresignResponse>
  confirm(
    userId: string,
    transactionId: string,
    input: ReviewMediaConfirmRequest,
  ): Promise<ReviewMediaConfirmResponse>
}

/** 评价图片送审配置：provider 按需创建（loadImage 回放本次读到的字节）。 */
export interface ReviewImageModerationConfig {
  createProvider(loadImage: LoadModerationImage): ContentModerationProvider
  /** 腾讯 IMS 策略号（审计列）；local transport 为 null。 */
  bizType: string | null
}

export function createReviewMediaService(options: {
  gate: ReviewMediaGate
  storage: MediaStorage
  /** 审核台账；缺失时 confirm fail-closed 503（不能在没有记录的情况下产出公开键）。 */
  moderationStore?: ReviewModerationStore
  /** 缺省本地 provider（图片恒 REVIEW），生产装配注入腾讯 IMS。 */
  moderation?: ReviewImageModerationConfig
  /** 令牌桶可注入（测试用假时钟/小容量）；缺省按用户限速：突发 10、约 10/分钟补充。 */
  limiter?: {
    take(subject: string): { allowed: true } | { allowed: false; retryAfterSeconds: number }
  }
}): ReviewMediaService {
  const { gate, storage, moderationStore } = options
  const limiter =
    options.limiter ??
    createTokenBucketLimiter({ capacity: 10, maxSubjects: 10_000, refillPerSecond: 10 / 60 })

  function assertWithinRate(userId: string): void {
    const decision = limiter.take(userId)
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds)
  }

  async function requireGate(transactionId: string, userId: string): Promise<{ id: string }> {
    const state = await gate.transactionGate(transactionId, userId)
    if (!state) throw transactionNotFound()
    if (state.status !== 'COMPLETED') throw notCompleted()
    // 评价不可修改（冻结口径）——已评过就没有再上传的语义，提前 409 而不是让 confirm 白跑。
    if (state.hasReview) throw reviewExists()
    return { id: state.id }
  }

  /**
   * 存储运行错误 = 可重试的服务故障（#483 审查响应）：记日志后显式 503，
   * 不让 MinIO 抖动伪装成 422「图片无效」。
   */
  function asServiceOutage<T>(stage: string, op: Promise<T>): Promise<T> {
    return op.catch((error: unknown) => {
      console.error(`[review-media] 存储操作失败（${stage}），按 503 服务故障处理`, error)
      throw storageUnavailable()
    })
  }

  /** 台账行 → confirm 响应；BLOCK 行永远不会被当成可引用对象。 */
  function responseOf(record: ReviewModerationRow): ReviewMediaConfirmResponse {
    const decision = effectiveReviewModerationDecision(record)
    if (decision === 'BLOCK' || !record.finalKey) throw imageBlocked()
    return {
      objectKey: record.finalKey,
      url: storage.publicUrl(record.finalKey),
      moderationDecision: decision,
    }
  }

  return {
    async presign(userId, transactionId, input) {
      assertWithinRate(userId)
      await requireGate(transactionId, userId)
      // 键由服务端生成且必带 userId：confirm 与写侧引用校验都只靠这个前缀判归属。
      // presign 永不签 `reviews/`（final）——final 只能由 confirm 在审核后产出。
      const objectKey = `${reviewMediaStagingPrefix(userId)}${encodePublicId(
        PUBLIC_ID_PREFIX.media,
        newId(),
      )}.${EXTENSION_BY_MIME[input.contentType]}`
      const signed = storage.presignPut({ key: objectKey, contentType: input.contentType })
      return {
        uploadUrl: signed.url,
        objectKey,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      }
    },

    async confirm(userId, transactionId, input) {
      assertWithinRate(userId)
      const txn = await requireGate(transactionId, userId)
      const moderation = options.moderation ?? {
        createProvider: () => createLocalContentModerationProvider(),
        bizType: null,
      }
      if (
        !moderationStore ||
        !storage.statStrict ||
        !storage.readMediaBytes ||
        !storage.writeMediaBytesIfAbsent
      ) {
        throw storageUnavailable()
      }
      const { statStrict, readMediaBytes, writeMediaBytesIfAbsent, delete: deleteObject } = storage
      const key = input.objectKey
      // 形状 + 归属（`..`/编码绕过由 isSafeObjectKey 前提挡住，见 uploads/storage.ts 头注释）。
      if (!isReviewMediaStagingKey(key) || !key.startsWith(reviewMediaStagingPrefix(userId))) {
        throw invalidKey()
      }

      // 由 staging 键派生两个候选 final 键（只换前缀，media 段原样保留）。
      const filename = key.slice(reviewMediaStagingPrefix(userId).length)
      const publicKey = `${reviewMediaPublicPrefix(userId)}${filename}`
      const privateKey = `${reviewModerationMediaPrefix(userId)}${filename}`

      const stat = await asServiceOutage('stat staging', statStrict(key))
      if (!stat) {
        // staging 可能已被生命周期策略清理：只要台账里有这次 confirm 的结论，重试仍幂等。
        const recorded = await moderationStore.findByStagingKey({
          userId,
          stagingKey: key,
        })
        if (recorded) return responseOf(recorded)
        throw invalidKey()
      }
      if (stat.size > MAX_IMAGE_BYTES || !ALLOWED_MIME.has(stat.contentType)) throw invalidKey()
      const bytes = await asServiceOutage('read staging', readMediaBytes(key))
      // stat 刚成功、此刻却读不到：对象在确认中途消失属存储故障，不是「图片无效」。
      if (!bytes) throw storageUnavailable()
      // 真实内容判据：魔数必须与声明的 MIME 一致（扩展名/声明值都不可信）。
      if (bytes.byteLength !== stat.size) throw invalidKey()
      if (sniffImageMime(bytes) !== stat.contentType) throw invalidKey()

      const contentDigest = createHash('sha256').update(bytes).digest('hex')

      // 幂等快路径：同一 staging 的同一份字节已经审过 → 直接给出既有结论，不重跑 IMS。
      const existing = await moderationStore.findByDigest({
        userId,
        stagingKey: key,
        contentDigest,
      })
      if (existing) return responseOf(existing)

      // loadImage 回放**本次读到的字节**：provider 不再读对象存储，审核对象与固化对象同源。
      const provider = moderation.createProvider(async (objectKey) =>
        objectKey === key ? { bytes, contentType: stat.contentType } : null,
      )

      let verdict: Awaited<ReturnType<ContentModerationProvider['moderateImage']>>
      try {
        verdict = await provider.moderateImage({
          // 腾讯 DataId 白名单 `[A-Za-z0-9_@#-]{1,64}`：由内容摘要派生，稳定且可关联重试。
          dataId: `rv-${contentDigest.slice(0, 61)}`,
          objectKey: key,
        })
      } catch (error) {
        if (!(error instanceof ContentModerationError)) throw error
        console.warn('[review-media] 图片送审失败，按 fail-closed 处理', {
          reason: error.reason,
          provider: error.provider,
          requestId: error.requestId,
          detail: error.detail,
        })
        if (error.reason === 'invalid_input') throw invalidKey()
        throw moderationUnavailable()
      }

      // 腾讯的 FileMD5 必须等于我们对同一份字节算的 md5；不一致说明上游看的不是这次读的字节。
      const providerMd5 = verdict.transport === 'tencent' ? verdict.contentDigest : null
      if (verdict.transport === 'tencent') {
        const localMd5 = createHash('md5').update(bytes).digest('hex')
        if (!providerMd5 || providerMd5 !== localMd5) {
          console.warn('[review-media] 上游摘要与本地字节不一致，按 fail-closed 处理', {
            provider: verdict.provider,
            requestId: verdict.requestId,
          })
          throw moderationUnavailable()
        }
      }

      const baseRecord = {
        userId,
        transactionId: txn.id,
        stagingKey: key,
        contentType: stat.contentType,
        sizeBytes: stat.size,
        contentDigest,
        providerMd5,
        provider: verdict.provider,
        providerRequestId: verdict.requestId,
        policyVersion: verdict.policyVersion,
        bizType: moderation.bizType,
        suggestion: verdict.suggestion,
        label: verdict.label,
        subLabel: verdict.subLabel,
        score: verdict.score,
        // provider 不单独返回规则码；subLabel 已单列存储，这里不再重复。
        matchedRules: [],
        matchedTermsMasked: verdict.maskedTerms ?? [],
      }

      if (verdict.decision === 'BLOCK') {
        const inserted = await moderationStore.insert({
          ...baseRecord,
          finalKey: null,
          moderationDecision: 'BLOCK',
        })
        // 输给并发 confirm：以先落库的结论为准（同摘要下判定本应一致，但仍不覆盖）。
        if (!inserted) {
          const winner =
            (await moderationStore.findByDigest({
              userId,
              stagingKey: key,
              contentDigest,
            })) ?? (await moderationStore.findByStagingKey({ userId, stagingKey: key }))
          if (winner && winner.contentDigest === contentDigest) return responseOf(winner)
        }
        // 不得留下可被再次引用的 staging 对象；删除失败不影响 422（final 键本来就不存在）。
        if (deleteObject) {
          await deleteObject(key).catch((error: unknown) => {
            console.warn('[review-media] BLOCK 后删除 staging 失败，已忽略', { error })
          })
        }
        throw imageBlocked()
      }

      const finalKey = verdict.decision === 'ALLOW' ? publicKey : privateKey
      const written = await asServiceOutage(
        'write final',
        writeMediaBytesIfAbsent(finalKey, bytes, stat.contentType),
      )
      if (!written) {
        // final 已存在：必须是同一份字节才允许复用；不同 → staging 已被替换/键被占用。
        const current = await asServiceOutage('read existing final', readMediaBytes(finalKey))
        if (
          !current ||
          current.byteLength !== bytes.byteLength ||
          createHash('sha256').update(current).digest('hex') !== contentDigest
        ) {
          throw invalidKey()
        }
      }

      const inserted = await moderationStore.insert({
        ...baseRecord,
        finalKey,
        moderationDecision: verdict.decision,
      })
      if (inserted) {
        return responseOf(inserted)
      }
      // 并发输家：读赢家。若赢家摘要不同（同一 staging 被换过字节且 final 尚不存在）→ 拒绝。
      const winner =
        (await moderationStore.findByDigest({
          userId,
          stagingKey: key,
          contentDigest,
        })) ?? (await moderationStore.findByStagingKey({ userId, stagingKey: key }))
      if (!winner || winner.contentDigest !== contentDigest) throw invalidKey()
      return responseOf(winner)
    },
  }
}
