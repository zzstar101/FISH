import {
  ALLOWED_IMAGE_MIME,
  type ListingErrorCode,
  MAX_IMAGE_BYTES,
  type UploadConfirmRequest,
  type UploadConfirmResponse,
  type UploadPresignRequest,
  type UploadPresignResponse,
} from '@fish/contracts/listings/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { newId } from '@fish/db/ids'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { isPublicListingKey, isSafeObjectKey, type MediaStorage } from './storage'

export class UploadServiceError extends Error {
  /**
   * `details` 不是只有 `VALIDATION_FAILED` 才有：契约 §3 的 422 校验类失败都会带字段信息
   * （`IMAGE_REFERENCE_INVALID` / `UPLOAD_OBJECT_MISSING` 指向 `objectKey`），
   * 否则前端拿不到"是哪个输入出错"。已在契约 §7.9 记录这条口径。
   */
  constructor(
    readonly status: 422,
    readonly code: ListingErrorCode,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'UploadServiceError'
  }
}

/** 上传域的所有失败都指向同一个字段，避免每个 throw 各写一遍。 */
const objectKeyDetail = (message: string): ApiErrorDetail[] => [{ field: 'objectKey', message }]

export interface UploadService {
  presign(userId: string, input: UploadPresignRequest): Promise<UploadPresignResponse>
  confirm(userId: string, input: UploadConfirmRequest): Promise<UploadConfirmResponse>
}

/** 新对象键只使用规范 TypeID；旧 UUID 对象键由 listing 读取链路兼容。 */
const publicListingPrefix = (userId: string) =>
  `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`

/** 扩展名由 mime 推导，不接受客户端指定。 */
const EXTENSION_BY_MIME: Record<(typeof ALLOWED_IMAGE_MIME)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function createUploadService(deps: { storage: MediaStorage }): UploadService {
  const { storage } = deps

  return {
    async presign(userId, input) {
      // 对象键由服务端生成，且必须带 userId：create 时只靠这个前缀校验归属，
      // 不需要新增"上传登记表"（契约 §2.3）。
      const objectKey = `${publicListingPrefix(userId)}${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.${EXTENSION_BY_MIME[input.contentType]}`
      const signed = storage.presignPut({ key: objectKey, contentType: input.contentType })

      return {
        uploadUrl: signed.url,
        objectKey,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      }
    },

    async confirm(userId, input) {
      // 形状检查必须排在 `startsWith` 之前，且不是冗余：`Bun.S3Client` 拼 URL 时会归一化
      // pathname，`listings/{我}/../{别人}/x.jpg` 能通过前缀校验却指到别人的对象上
      // （#86 B 线评审 P1）。storage.stat 里也有一道同样的关，这里是第二道，顺带给出
      // 比"对象不存在"更准确的错误码。
      if (
        !isSafeObjectKey(input.objectKey) ||
        !isPublicListingKey(input.objectKey) ||
        !input.objectKey.startsWith(publicListingPrefix(userId))
      ) {
        throw new UploadServiceError(
          422,
          'IMAGE_REFERENCE_INVALID',
          '图片不属于当前用户',
          objectKeyDetail('图片不属于当前用户'),
        )
      }

      const stat = await storage.stat(input.objectKey)
      if (!stat) {
        throw new UploadServiceError(
          422,
          'UPLOAD_OBJECT_MISSING',
          '图片尚未上传完成',
          objectKeyDetail('图片尚未上传完成'),
        )
      }

      // presign 的签名只覆盖 host，mime 不受约束（契约 §7.7）：真实大小与类型只能在这里查。
      // 拦在这里，前端能在预览前就拿到明确失败，而不是等 create 才 422。
      if (stat.size > MAX_IMAGE_BYTES || !isAllowedMime(stat.contentType)) {
        throw new UploadServiceError(
          422,
          'IMAGE_REFERENCE_INVALID',
          '图片格式或大小不符合要求',
          objectKeyDetail('图片格式或大小不符合要求'),
        )
      }

      return { objectKey: input.objectKey, url: storage.publicUrl(input.objectKey) }
    },
  }
}

function isAllowedMime(contentType: string): boolean {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(contentType)
}
