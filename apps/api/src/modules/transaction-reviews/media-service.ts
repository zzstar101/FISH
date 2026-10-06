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
import { createTokenBucketLimiter } from '../recommendation/rate-limit'
import type { MediaObjectStat, MediaStorage } from '../uploads/storage'
import {
  isReviewMediaStagingKey,
  reviewMediaPublicPrefix,
  reviewMediaStagingPrefix,
} from '../uploads/storage'

/**
 * 评价配图上传链（#475）：presign（签 staging）→ 客户端直传 → confirm（校验并固化到私有 final 键）。
 *
 * 与 listing 的上传链同形但**独立成链**（票内决策：不动 `/uploads/*` 的既有 listing 语义）：
 * - 键域函数与写入端引用校验共用 `../uploads/storage` 的同一族函数（改名即编译错）；
 * - **不做内容审核**（票内待冻结项 3 取默认：本期不进 IMS；chat-media 现状同款），
 *   因此没有 staging→IMS→固化 的结算机，confirm 只做形状/归属/存在/大小/MIME/真实图片校验；
 * - **无登记表**：presign 永不签 final 前缀，所以「final 键下对象存在」本身就证明经过本链 confirm。
 * - **confirm 幂等且不覆盖**（#483 审查响应）：final 已存在即视为本次（或此前）confirm 已成功，
 *   直接返回同一 final 键、绝不重写——同一 staging 键换一笔交易再 confirm 也改不掉
 *   已提交评价引用的图；重试安全性因此不依赖 staging 对象还活着。
 * - **授权门是反滥用门，键不绑定交易**：键 `reviews/{usr_…}/{med_…}.ext` 不含交易段，
 *   同一用户可以把在交易 A 下 confirm 的图引用到交易 B 的评价里（两笔都需 COMPLETED 且本人未评价）。
 *   验收只要求「键来自本链且属于本人」，本期即此语义；要绑定交易需在键里加交易段或引入登记表。
 * - **频控**：confirm 若完全无上限，本链就是一条「向私有 final 前缀不限量写对象」的通道——
 *   按用户令牌桶兜底（与契约的 3 张上限是两个维度：那个约束单条评价引用几张，这个约束产出速率）。
 * - **存储运行错误显式 503**（#483 审查响应）：stat 用 `statStrict`（只有真不存在才是 422），
 *   读/写的运行错误不吞——MinIO 抖动是可重试的服务故障，不能伪装成「图片无效」让用户重传。
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

const invalidKey = () =>
  new ReviewMediaServiceError(422, 'REVIEW_IMAGE_INVALID', '图片对象不可引用，请重新上传', [
    { field: 'objectKey', message: '图片对象不可引用' },
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
  /** 返回 `null` = 不是参与者/交易不存在（404）；否则给出状态与「我是否已评价」。 */
  transactionGate(
    transactionId: string,
    userId: string,
  ): Promise<{ status: string; hasReview: boolean } | null>
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

export function createReviewMediaService(options: {
  gate: ReviewMediaGate
  storage: MediaStorage
  /** 令牌桶可注入（测试用假时钟/小容量）；缺省按用户限速：突发 10、约 10/分钟补充。 */
  limiter?: {
    take(subject: string): { allowed: true } | { allowed: false; retryAfterSeconds: number }
  }
}): ReviewMediaService {
  const { gate, storage } = options
  const limiter =
    options.limiter ??
    createTokenBucketLimiter({ capacity: 10, maxSubjects: 10_000, refillPerSecond: 10 / 60 })

  function assertWithinRate(userId: string): void {
    const decision = limiter.take(userId)
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds)
  }

  async function requireGate(transactionId: string, userId: string): Promise<void> {
    const state = await gate.transactionGate(transactionId, userId)
    if (!state) throw transactionNotFound()
    if (state.status !== 'COMPLETED') throw notCompleted()
    // 评价不可修改（冻结口径）——已评过就没有再上传的语义，提前 409 而不是让 confirm 白跑。
    if (state.hasReview) throw reviewExists()
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

  return {
    async presign(userId, transactionId, input) {
      assertWithinRate(userId)
      await requireGate(transactionId, userId)
      // 键由服务端生成且必带 userId：confirm 与写侧引用校验都只靠这个前缀判归属。
      // presign 永不签 `reviews/`（final）——这是「无登记表」安全性的根据。
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
      await requireGate(transactionId, userId)
      if (!storage.statStrict || !storage.readMediaBytes || !storage.writeMediaBytesIfAbsent) {
        throw storageUnavailable()
      }
      const { statStrict, readMediaBytes, writeMediaBytesIfAbsent } = storage
      const key = input.objectKey
      // 形状 + 归属（`..`/编码绕过由 isSafeObjectKey 前提挡住，见 uploads/storage.ts 头注释）。
      if (!isReviewMediaStagingKey(key) || !key.startsWith(reviewMediaStagingPrefix(userId))) {
        throw invalidKey()
      }

      // 由 staging 键派生 final 键：**只换前缀**（media 段原样保留 —— 它已经是公开 id，
      // 再走一次 encodePublicId 会二次编码）。
      const finalKey = key.replace(
        reviewMediaStagingPrefix(userId),
        reviewMediaPublicPrefix(userId),
      )
      // #483 审查响应：幂等只保证同一 staging 键首次固化的内容；final 已存在即成功返回，
      // 绝不重写。同一 staging 键换一笔交易再 confirm，已提交评价引用的图保持原样。
      const existing: MediaObjectStat | null = await asServiceOutage(
        'stat final',
        statStrict(finalKey),
      )
      if (existing) return { objectKey: finalKey, url: storage.publicUrl(finalKey) }

      const stat = await asServiceOutage('stat staging', statStrict(key))
      if (!stat) throw invalidKey()
      if (stat.size > MAX_IMAGE_BYTES || !ALLOWED_MIME.has(stat.contentType)) throw invalidKey()
      const bytes = await asServiceOutage('read staging', readMediaBytes(key))
      // stat 刚成功、此刻却读不到：对象在确认中途消失属存储故障，不是「图片无效」。
      if (!bytes) throw storageUnavailable()
      // 真实内容判据：魔数必须与声明的 MIME 一致（扩展名/声明值都不可信）。
      if (bytes.byteLength !== stat.size) throw invalidKey()
      if (sniffImageMime(bytes) !== stat.contentType) throw invalidKey()

      // 前置 stat 只用于幂等快路径，不能承担互斥：多个 confirm 可同时观察到不存在。
      // If-None-Match:* 在对象存储端原子仲裁，输家复用已固化的 final，不覆盖其字节。
      await asServiceOutage(
        'write final',
        writeMediaBytesIfAbsent(finalKey, bytes, stat.contentType),
      )
      return { objectKey: finalKey, url: storage.publicUrl(finalKey) }
    },
  }
}
