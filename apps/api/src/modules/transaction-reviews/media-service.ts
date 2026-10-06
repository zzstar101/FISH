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
import type { MediaStorage } from '../uploads/storage'
import {
  isReviewMediaStagingKey,
  reviewMediaPublicPrefix,
  reviewMediaStagingPrefix,
} from '../uploads/storage'

/**
 * 评价配图上传链（#475）：presign（签 staging）→ 客户端直传 → confirm（校验并固化到公开 final 键）。
 *
 * 与 listing 的上传链同形但**独立成链**（票内决策：不动 `/uploads/*` 的既有 listing 语义）：
 * - 键域函数与写入端引用校验共用 `../uploads/storage` 的同一族函数（改名即编译错）；
 * - **不做内容审核**（票内待冻结项 3 取默认：本期不进 IMS；chat-media 现状同款），
 *   因此没有 staging→IMS→固化 的结算机，confirm 只做形状/归属/存在/大小/MIME/真实图片校验；
 * - **无登记表**：presign 永不签 final 前缀，所以「final 键下对象存在」本身就证明经过本链 confirm。
 */

export class ReviewMediaServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[],
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
}): ReviewMediaService {
  const { gate, storage } = options

  async function requireGate(transactionId: string, userId: string): Promise<void> {
    const state = await gate.transactionGate(transactionId, userId)
    if (!state) throw transactionNotFound()
    if (state.status !== 'COMPLETED') throw notCompleted()
    // 评价不可修改（冻结口径）——已评过就没有再上传的语义，提前 409 而不是让 confirm 白跑。
    if (state.hasReview) throw reviewExists()
  }

  return {
    async presign(userId, transactionId, input) {
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
      await requireGate(transactionId, userId)
      const key = input.objectKey
      // 形状 + 归属（`..`/编码绕过由 isSafeObjectKey 前提挡住，见 uploads/storage.ts 头注释）。
      if (!isReviewMediaStagingKey(key) || !key.startsWith(reviewMediaStagingPrefix(userId))) {
        throw invalidKey()
      }
      const stat = await storage.stat(key)
      if (!stat) throw invalidKey()
      if (stat.size > MAX_IMAGE_BYTES || !ALLOWED_MIME.has(stat.contentType)) throw invalidKey()
      const bytes = await storage.readMediaBytes?.(key)
      if (!bytes || bytes.byteLength !== stat.size) throw invalidKey()
      // 真实内容判据：魔数必须与声明的 MIME 一致（扩展名/声明值都不可信）。
      if (sniffImageMime(bytes) !== stat.contentType) throw invalidKey()

      // 由 staging 键派生 final 键：**只换前缀**（media 段原样保留 —— 它已经是公开 id，
      // 再走一次 encodePublicId 会二次编码）。同一 media id ⇒ confirm 重试幂等覆盖同一对象。
      const finalKey = key.replace(
        reviewMediaStagingPrefix(userId),
        reviewMediaPublicPrefix(userId),
      )
      await storage.writeMediaBytes?.(finalKey, bytes, stat.contentType)
      return { objectKey: finalKey, url: storage.publicUrl(finalKey) }
    },
  }
}
