import { createHash } from 'node:crypto'
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
import type { LoadModerationImage } from '../moderation/providers/tencent'
import {
  ContentModerationError,
  type ContentModerationProvider,
  moderationErrorResponse,
} from '../moderation/providers/types'
import type { ListingMediaObjectRow, ListingMediaObjectStore } from './media-objects'
import {
  isListingMediaStagingKey,
  isPublicListingKey,
  isSafeObjectKey,
  listingMediaStagingPrefix,
  type MediaStorage,
} from './storage'

export class UploadServiceError extends Error {
  /**
   * `details` 不是只有 `VALIDATION_FAILED` 才有：契约 §3 的 422 校验类失败都会带字段信息
   * （`IMAGE_REFERENCE_INVALID` / `UPLOAD_OBJECT_MISSING` 指向 `objectKey`），
   * 否则前端拿不到"是哪个输入出错"。已在契约 §7.9 记录这条口径。
   */
  constructor(
    // 503 是 #286 新增的：审核不可用时**不固化、不放行**，只能稍后重试。
    readonly status: 400 | 422 | 503,
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

/** 固化后的可引用对象键前缀（= 现有 `isPublicListingKey` 的前缀，公开读只放开了它）。 */
const publicListingPrefix = (userId: string) =>
  `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`

/** 扩展名由 mime 推导，不接受客户端指定。 */
const EXTENSION_BY_MIME: Record<(typeof ALLOWED_IMAGE_MIME)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * #286：图片 staging → IMS → 固化 final 的两步链路。
 *
 * 1. `presign` 只签 **staging** 前缀 `listing-media/{userId}/…`。它不在匿名读白名单里（见
 *    `docs/deployment.md`），所以未过审的图天然不公开；更关键的是客户端**结构上拿不到**
 *    `listings/` 前缀的签名，于是"审核通过后用 PUT 覆盖同一对象"这条绕过从「要靠摘要比对」
 *    降级成「做不到」。
 * 2. `confirm` 读**全量**字节 → 喂给注入的 `loadImage` 做 IMS 审核 → 只有拿到内容摘要才固化到
 *    服务端生成的 `listings/…` final 键，并用 `(userId, stagingKey, sha256)` 复用既有结论
 *    （接口重试不会重复计费审核）。
 *
 * `createModeration` 是**工厂**而不是实例：每次 confirm 现绑一个 provider，注入的 `loadImage`
 * 直接回放本次已经读到的字节，对象存储因此只读一次；provider 内部的重试只重放 IMS 调用
 * （见 `providers/tencent.ts` 的 `withBoundedRetry`），不会重新读图。
 */
export function createUploadService(deps: {
  storage: MediaStorage
  mediaObjects: ListingMediaObjectStore
  createModeration: (loadImage: LoadModerationImage) => ContentModerationProvider
}): UploadService {
  const { storage, mediaObjects, createModeration } = deps

  /** 复用一个已经落库的结论（幂等快速路径）。 */
  function reuse(row: ListingMediaObjectRow): UploadConfirmResponse {
    if (row.moderationDecision === 'BLOCK') {
      throw new UploadServiceError(
        422,
        'IMAGE_CONTENT_BLOCKED',
        '图片内容未通过审核',
        objectKeyDetail('图片内容未通过审核'),
      )
    }
    // DB 的 `listing_media_objects_final_key_required` 保证非 BLOCK 行必有 final 键；
    // 真出现脏行宁可 503 也不要拿一个空键去换一个 500。
    if (row.finalKey === null) {
      console.error('[uploads] 审核记录缺少 final 键', row.id)
      throw new UploadServiceError(
        503,
        'CONTENT_MODERATION_UNAVAILABLE',
        '图片确认状态不可用，请稍后重试',
        objectKeyDetail('图片确认状态不可用，请稍后重试'),
      )
    }
    return { objectKey: row.finalKey, url: storage.publicUrl(row.finalKey) }
  }

  return {
    async presign(userId, input) {
      // 对象键由服务端生成，且必须带 userId：confirm 与 Listing 引用校验都只靠这个前缀判归属。
      // 注意这里签的是 staging 前缀 —— presign 永不签 `listings/`。
      const objectKey = `${listingMediaStagingPrefix(userId)}${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.${EXTENSION_BY_MIME[input.contentType]}`
      const signed = storage.presignPut({ key: objectKey, contentType: input.contentType })

      return {
        uploadUrl: signed.url,
        objectKey,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      }
    },

    async confirm(userId, input) {
      // 已经确认过的 **final** 键会再交回来一次：改头像（`PATCH /profile` 的 `avatarObjectKey`）
      // 拿到的就是客户端上一次 confirm 的返回值，服务端仍然调同一个 confirm 校验它（见
      // `modules/profile/service.ts`）。它不是一次新的上传，因此不读字节、不重新审核，只验证
      // 「这个键确实是当前用户已确认、且未被 BLOCK 的对象」。
      if (isSafeObjectKey(input.objectKey) && isPublicListingKey(input.objectKey)) {
        if (!input.objectKey.startsWith(publicListingPrefix(userId))) {
          throw new UploadServiceError(
            422,
            'IMAGE_REFERENCE_INVALID',
            '图片不属于当前用户',
            objectKeyDetail('图片不属于当前用户'),
          )
        }
        const confirmed = await mediaObjects.findConfirmedFinalKey(input.objectKey)
        if (!confirmed || confirmed.userId !== userId) {
          throw new UploadServiceError(
            422,
            'IMAGE_REFERENCE_INVALID',
            '图片尚未通过审核，请重新上传',
            objectKeyDetail('图片尚未通过审核，请重新上传'),
          )
        }
        return { objectKey: confirmed.finalKey, url: storage.publicUrl(confirmed.finalKey) }
      }

      // 形状检查必须排在 `startsWith` 之前，且不是冗余：`Bun.S3Client` 拼 URL 时会归一化
      // pathname，`listing-media/{我}/../{别人}/x.jpg` 能通过前缀校验却指到别人的对象上
      // （#86 B 线评审 P1）。storage.stat 里也有一道同样的关，这里是第二道，顺带给出
      // 比"对象不存在"更准确的错误码。
      if (
        !isSafeObjectKey(input.objectKey) ||
        !isListingMediaStagingKey(input.objectKey) ||
        !input.objectKey.startsWith(listingMediaStagingPrefix(userId))
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
      // mime 单独判一次是为了让 `isAllowedMime` 的类型收窄生效（后面查扩展名要用）。
      const { contentType } = stat
      if (stat.size > MAX_IMAGE_BYTES || !isAllowedMime(contentType)) {
        throw new UploadServiceError(
          422,
          'IMAGE_REFERENCE_INVALID',
          '图片格式或大小不符合要求',
          objectKeyDetail('图片格式或大小不符合要求'),
        )
      }

      // confirm 的两条安全性质（审核、固化）都要求能读到全量字节并写出快照，缺一不可。
      if (!storage.readMediaBytes || !storage.writeMediaBytes) {
        throw new UploadServiceError(
          503,
          'CONTENT_MODERATION_UNAVAILABLE',
          '图片审核确认暂时不可用',
          objectKeyDetail('对象存储未提供内容读取与固化能力，无法完成审核确认'),
        )
      }

      // 只读**一次**全量对象：这份字节同时用于本地摘要、IMS 审核与固化快照。
      // `readMediaBytes` 会多读 1 字节，用来区分"恰好到上限"与"超限"。
      const bytes = await storage.readMediaBytes(input.objectKey, MAX_IMAGE_BYTES)
      if (!bytes || bytes.length === 0) {
        throw new UploadServiceError(
          422,
          'UPLOAD_OBJECT_MISSING',
          '图片尚未上传完成',
          objectKeyDetail('图片尚未上传完成'),
        )
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new UploadServiceError(
          422,
          'IMAGE_REFERENCE_INVALID',
          '图片格式或大小不符合要求',
          objectKeyDetail('图片格式或大小不符合要求'),
        )
      }
      // stat 与实读字节不一致 ⇒ 对象在 stat 与读之间被 PUT 覆盖了。此时既不能拿"这一次的属性"
      // 去固化"另一次的字节"，也不能把审核结论算在没读到的内容上 —— 直接要求重新上传。
      if (bytes.length !== stat.size) {
        throw new UploadServiceError(
          422,
          'IMAGE_REFERENCE_INVALID',
          '图片内容与元数据不一致，请重新上传',
          objectKeyDetail('图片内容与元数据不一致，请重新上传'),
        )
      }

      const contentDigest = createHash('sha256').update(bytes).digest('hex')

      // 幂等快速路径：同一个 staging 键在当前字节内容下已经有结论就复用，不再打一次 IMS
      // （接口重试不重复计费）。staging 键被 PUT 覆盖成别的内容时摘要不同 ⇒ 不命中 ⇒ 重新审核。
      const replayed = await mediaObjects.findByDigest({
        userId,
        stagingKey: input.objectKey,
        contentDigest,
      })
      if (replayed) return reuse(replayed)

      const provider = createModeration(async (objectKey) =>
        objectKey === input.objectKey ? { bytes, contentType: stat.contentType } : null,
      )
      let verdict: Awaited<ReturnType<ContentModerationProvider['moderateImage']>>
      try {
        // dataId 用本地摘要：它满足腾讯的 `^[A-Za-z0-9_@#-]{1,64}$`，且同一份内容必然同名，
        // 便于上游按内容去重与追踪。
        verdict = await provider.moderateImage({
          dataId: contentDigest,
          objectKey: input.objectKey,
        })
      } catch (error) {
        // #228 安全条件 1：外部审核失败**不放行**。映射成 503/400，且不固化任何对象。
        if (error instanceof ContentModerationError) {
          const mapped = moderationErrorResponse(error)
          throw new UploadServiceError(
            mapped.status,
            mapped.code,
            '图片审核暂时不可用，请稍后重试',
            objectKeyDetail('图片审核暂时不可用，请稍后重试'),
          )
        }
        throw error
      }

      // 本 Issue 的断言：`ALLOW` 必须**同时**带内容摘要才可信 —— 拿不到摘要就无法证明"审核的就是
      // 这批字节"，等价于没审。宁可 503 让用户重试，也不产生"看起来已审核"的公开对象。
      //
      // 本地 provider 恒返回 `contentDigest: null`，但它的结论是 `REVIEW`（`LOCAL_IMAGE_NOT_AUDITED`，
      // 见 providers/local.ts），所以不会走到这个分支：本地环境下图片照样能确认，只是商品会带着
      // `REVIEW` 进人工队列（`index.ts` 启动日志里"图片一律进人工队列"说的就是这条）。
      if (verdict.decision === 'ALLOW' && verdict.contentDigest === null) {
        throw new UploadServiceError(
          503,
          'CONTENT_MODERATION_UNAVAILABLE',
          '图片内容未完成审核，无法确认',
          objectKeyDetail('图片审核未返回内容摘要，无法确认'),
        )
      }

      const record = {
        userId,
        stagingKey: input.objectKey,
        contentDigest,
        providerMd5: verdict.contentDigest,
        moderationDecision: verdict.decision,
        provider: verdict.provider,
        providerRequestId: verdict.requestId,
      }

      // BLOCK：只留审计行，**不固化**。因此被阻断的图不可能出现在 `listings/` 前缀下，
      // 也不可能被 Listing 引用（引用校验要求存在已确认行）。
      if (verdict.decision === 'BLOCK') {
        await mediaObjects.insert({ ...record, finalKey: null })
        throw new UploadServiceError(
          422,
          'IMAGE_CONTENT_BLOCKED',
          '图片内容未通过审核',
          objectKeyDetail('图片内容未通过审核'),
        )
      }

      // ALLOW / REVIEW 都固化（#286 步骤 3 明确写了 "Pass / Review → writeMediaBytes"）：REVIEW 的
      // 图可以进 Listing，但审核结论会跟着 final 键回到 `assertUsableObjectKeys`，由商品链把整条
      // 商品压进人工队列（见 listings/service.ts）——不是公开。
      const finalKey = `${publicListingPrefix(userId)}${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.${EXTENSION_BY_MIME[contentType]}`
      await storage.writeMediaBytes(finalKey, bytes, contentType)

      const inserted = await mediaObjects.insert({ ...record, finalKey })
      if (inserted) return { objectKey: finalKey, url: storage.publicUrl(finalKey) }

      // 并发 confirm 抢先落库（唯一索引挡下）：改用先落库那一行的 final 键。本次写的对象成为
      // 孤儿，但内容相同且已过审，不影响可引用键的唯一性。
      const winner = await mediaObjects.findByDigest({
        userId,
        stagingKey: input.objectKey,
        contentDigest,
      })
      if (winner) return reuse(winner)

      // 结论没能落库 ⇒ 该键之后会被引用校验拒绝，不能返回给前端当"可用"。
      throw new UploadServiceError(
        503,
        'CONTENT_MODERATION_UNAVAILABLE',
        '图片确认状态未保存，请稍后重试',
        objectKeyDetail('图片确认状态未保存，请稍后重试'),
      )
    },
  }
}

function isAllowedMime(contentType: string): contentType is (typeof ALLOWED_IMAGE_MIME)[number] {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(contentType)
}
