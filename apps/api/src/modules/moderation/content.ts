import {
  ALLOWED_IMAGE_MIME,
  listingObjectKeyPrefix,
  MAX_IMAGE_BYTES,
} from '@fish/contracts/listings/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  aggregateModerationDecision,
  ContentModerationError,
  type ContentModerationProvider,
  type FieldModerationResult,
  moderationErrorResponse,
  type TextModerationResult,
} from '../moderation/providers/types'
import type { ModerationDecision, ModerationField } from '../moderation/types'
import { isLegacyListingKey } from '../uploads/legacy-url'
import { type ConfirmedImageLookup, effectiveModerationDecision } from '../uploads/media-objects'
import { isListingReviewMediaKey, listingReviewMediaPrefix } from '../uploads/review-media'
import { isListingMediaStagingKey, isPublicListingKey, type MediaStorage } from '../uploads/storage'

/**
 * 商品内容审核的**共享内核**（#228 文本审核 + #286 图片确认）。
 *
 * 为什么抽出来：#706 的出租发布与出售发布是两条独立的写路径（`/rentals` vs `/listings`），
 * 但审核口径**必须**完全一致 —— 两套词表、两套图片确认规则会让「同一条内容在出租能过、
 * 在出售被拒」这种不可解释的差异出现。抽成内核后，两个 service 只负责各自的业务字段，
 * 审核与媒体校验只有这一份实现。
 *
 * 本模块**不抛业务错误**：调用方传入 `reject` 回调，由它决定用哪个错误码（出售是
 * `ListingServiceError`，出租是 `RentalServiceError`）。这样两个域的错误信封保持独立，
 * 而判定逻辑不重复。
 */

/** 调用方提供的错误构造器：把「哪个字段错、为什么」翻成各自域的错误类型。 */
export type ModerationReject = (
  status: 400 | 422 | 503,
  code:
    | 'LISTING_CONTENT_BLOCKED'
    | 'IMAGE_CONTENT_BLOCKED'
    | 'IMAGE_REFERENCE_INVALID'
    | 'UPLOAD_OBJECT_MISSING',
  message: string,
  details?: ApiErrorDetail[],
) => never

export type ContentModerationDeps = {
  storage: MediaStorage
  moderationProvider: ContentModerationProvider
  mediaObjects: ConfirmedImageLookup
  pendingDeletions: { isPending(objectKey: string): Promise<boolean> }
  /** 该用户的 ID 重键历史（旧前缀的键仍可引用，见 `assertUsableObjectKeys`）。 */
  legacyUserIds(userId: string): Promise<string[]>
}

export interface ContentModeration {
  /** 文本审核（标题 + 描述）。provider 异常一律 fail-closed，由 `reject` 抛出。 */
  moderateText(input: {
    dataId: string
    title: string
    description: string
  }): Promise<TextModerationResult>
  /**
   * 校验一组图片键可用，并返回每张图的审核结论。
   *
   * `storedKeys` = 该商品图片组里**没变的老图**（编辑路径用；全新发布传空集）。
   * 老键豁免「审没审过」这一层，但仍要过前缀 / 存在性 / 大小校验。
   */
  assertUsableObjectKeys(input: {
    userId: string
    objectKeys: string[]
    storedKeys: ReadonlySet<string>
    reject: ModerationReject
  }): Promise<ModerationDecision[]>
  /** 编辑不带 `objectKeys` 时，按库里现有图片键回读结论（防止纯文本编辑洗掉图片 REVIEW）。 */
  imageDecisionsOfStoredKeys(input: {
    userId: string
    storedKeys: readonly string[]
  }): Promise<ModerationDecision[]>
  /** 文本 + 图片结论取最严一档（ALLOW < REVIEW < BLOCK）。 */
  aggregate(decisions: readonly ModerationDecision[]): ModerationDecision
}

export function createContentModeration(deps: ContentModerationDeps): ContentModeration {
  const { storage, moderationProvider, mediaObjects, pendingDeletions } = deps

  async function moderateText(input: {
    dataId: string
    title: string
    description: string
  }): Promise<TextModerationResult> {
    try {
      return await moderationProvider.moderateText({
        dataId: input.dataId,
        fields: [
          { field: 'title', value: input.title },
          { field: 'description', value: input.description },
        ],
      })
    } catch (error) {
      if (error instanceof ContentModerationError) {
        const mapped = moderationErrorResponse(error)
        // 400 = 内容本身不符合要求；其余（503 等）= provider 不可用。两者都不放行（fail closed）。
        throw new ContentModerationUnavailable(
          mapped.status,
          mapped.code,
          mapped.status === 400 ? '内容不符合审核要求' : '内容安全审核服务暂不可用，请稍后重试',
        )
      }
      throw error
    }
  }

  async function assertUsableObjectKeys(input: {
    userId: string
    objectKeys: string[]
    storedKeys: ReadonlySet<string>
    reject: ModerationReject
  }): Promise<ModerationDecision[]> {
    const { userId, objectKeys, storedKeys, reject } = input
    const publicPrefix = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`
    // #286 复审 blocker 2：`REVIEW` 图片固化在私有的 `listing-review-media/`（不在匿名白名单里），
    // 由签名代理读取。它对卖家来说是**正常的**可引用键：商品要带着审核中的图进人工队列，管理员才能
    // 看到这张图并做出结论。
    const reviewPrefix = listingReviewMediaPrefix(userId)
    const currentLegacyPrefix = listingObjectKeyPrefix(userId)
    const prefixes = objectKeys.every(
      (key) => key.startsWith(publicPrefix) || key.startsWith(reviewPrefix),
    )
      ? [currentLegacyPrefix]
      : [currentLegacyPrefix, ...(await deps.legacyUserIds(userId)).map(listingObjectKeyPrefix)]

    for (const objectKey of objectKeys) {
      // staging 键既能过"是自己前缀"，也能过对象存在性 —— 但它的内容**没有**经过审核固化。
      if (isListingMediaStagingKey(objectKey)) {
        reject(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
          { field: 'objectKeys', message: '图片尚未通过审核，请使用上传确认后返回的图片标识' },
        ])
      }
      if (
        !(isPublicListingKey(objectKey) && objectKey.startsWith(publicPrefix)) &&
        !(isListingReviewMediaKey(objectKey) && objectKey.startsWith(reviewPrefix)) &&
        !(isLegacyListingKey(objectKey) && prefixes.some((prefix) => objectKey.startsWith(prefix)))
      ) {
        reject(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
          { field: 'objectKeys', message: '图片不属于当前用户' },
        ])
      }
    }

    const decisions: ModerationDecision[] = []
    for (const objectKey of objectKeys) {
      // #476：已被摘除、等待回收的公开键**不能被重新引用**（窗口期问题见 `listings/service.ts`）。
      if (
        isPublicListingKey(objectKey) &&
        !storedKeys.has(objectKey) &&
        (await pendingDeletions.isPending(objectKey))
      ) {
        reject(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
          { field: 'objectKeys', message: '图片已不可用，请重新上传' },
        ])
      }
      // 两类服务端固化键都必须命中一行确认记录（#286）。
      if (isPublicListingKey(objectKey) || isListingReviewMediaKey(objectKey)) {
        const row = await mediaObjects.findByFinalKey(objectKey)
        const decision = row && row.userId === userId ? effectiveModerationDecision(row) : null
        if (decision === 'BLOCK') {
          reject(422, 'IMAGE_CONTENT_BLOCKED', '图片内容未通过审核', [
            { field: 'objectKeys', message: '图片内容未通过审核' },
          ])
        }
        if (decision !== null) {
          decisions.push(decision)
        } else if (!storedKeys.has(objectKey)) {
          reject(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
            { field: 'objectKeys', message: '图片尚未通过审核' },
          ])
        }
      }

      const stat = await storage.stat(objectKey)
      if (!stat) {
        reject(422, 'UPLOAD_OBJECT_MISSING', '图片尚未上传完成', [
          { field: 'objectKeys', message: '图片尚未上传完成' },
        ])
        // `reject` 的返回类型是 `never`，但 TS 不把回调的 never 当穷尽判定 —— 显式 continue
        // 否则下面读 `stat.size` 会报「可能为 null」。
        continue
      }
      if (
        stat.size > MAX_IMAGE_BYTES ||
        !(ALLOWED_IMAGE_MIME as readonly string[]).includes(stat.contentType)
      ) {
        reject(422, 'IMAGE_REFERENCE_INVALID', '图片格式或大小不符合要求', [
          { field: 'objectKeys', message: '图片格式或大小不符合要求' },
        ])
      }
    }

    return decisions
  }

  async function imageDecisionsOfStoredKeys(input: {
    userId: string
    storedKeys: readonly string[]
  }): Promise<ModerationDecision[]> {
    const decisions: ModerationDecision[] = []
    for (const objectKey of input.storedKeys) {
      if (!isPublicListingKey(objectKey) && !isListingReviewMediaKey(objectKey)) continue
      const row = await mediaObjects.findByFinalKey(objectKey)
      if (row && row.userId === input.userId) decisions.push(effectiveModerationDecision(row))
    }
    return decisions
  }

  return {
    moderateText,
    assertUsableObjectKeys,
    imageDecisionsOfStoredKeys,
    aggregate: aggregateModerationDecision,
  }
}

/**
 * provider 不可用 → 调用方的错误类型。携带原始 status / code，让两个 service 各自映射
 * 成自己的错误码表（出售是 `ListingErrorCode`，出租是 `RentalErrorCode`）。
 */
export class ContentModerationUnavailable extends Error {
  constructor(
    readonly status: 400 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ContentModerationUnavailable'
  }
}

/** #228：provider 结果里风险最高的那个字段（审计字段取它的 label/subLabel/score/requestId）。 */
export function tracedFieldOf(result: TextModerationResult): FieldModerationResult | null {
  return (
    result.fields.find((field) => field.decision === 'BLOCK') ??
    result.fields.find((field) => field.decision === 'REVIEW') ??
    result.fields[0] ??
    null
  )
}

/** 对外只给**既有安全码**（客户端已能翻译），绝不透出腾讯 Label/Score/命中策略（#228）。 */
export function moderationReasonCodeFor(decision: ModerationDecision): string | null {
  if (decision === 'BLOCK') return 'PROHIBITED_CONTENT'
  if (decision === 'REVIEW') return 'CONTENT_REQUIRES_REVIEW'
  return null
}

export type { ModerationField }
