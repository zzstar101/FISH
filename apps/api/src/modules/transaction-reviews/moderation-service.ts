import {
  type ReviewModerationDecisionInput,
  ReviewModerationDecisionResponseSchema,
  type ReviewModerationErrorCode,
  type ReviewModerationQueueQuery,
  ReviewModerationQueueResponseSchema,
} from '@fish/contracts/transaction-reviews/moderation'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor } from '../admin/cursor'
import {
  type ReviewModerationQueueRow,
  type ReviewModerationStore,
  ReviewModerationStoreError,
} from './moderation-store'

export class ReviewModerationServiceError extends Error {
  constructor(
    readonly code: ReviewModerationErrorCode,
    readonly status: 404 | 409 | 422 | 503,
    message: string,
  ) {
    super(message)
    this.name = 'ReviewModerationServiceError'
  }
}

export interface ReviewModerationService {
  list(
    query: ReviewModerationQueueQuery,
  ): Promise<ReturnType<typeof ReviewModerationQueueResponseSchema.parse>>
  decide(
    recordId: string,
    input: ReviewModerationDecisionInput,
    actorUserId: string,
  ): Promise<ReturnType<typeof ReviewModerationDecisionResponseSchema.parse>>
  findMedia(
    recordId: string,
  ): Promise<{ objectKey: string; contentType: string; sizeBytes: number } | null>
}

function toQueueItem(row: ReviewModerationQueueRow) {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, row.id),
    author: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.userId),
      nickname: row.authorNickname,
    },
    transaction: {
      id: encodePublicId(PUBLIC_ID_PREFIX.transaction, row.transactionId),
      listing: {
        id: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
        title: row.listingTitle,
      },
    },
    review: row.reviewId
      ? {
          id: encodePublicId(PUBLIC_ID_PREFIX.review, row.reviewId),
          rating: row.reviewRating as 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE',
          body: row.reviewBody,
          createdAt: row.reviewCreatedAt as string,
        }
      : null,
    image: { contentType: row.contentType, sizeBytes: row.sizeBytes },
    decision: row.moderationDecision,
    provider: row.provider as 'LOCAL' | 'TENCENT_IMS',
    providerRequestId: row.providerRequestId,
    policyVersion: row.policyVersion,
    bizType: row.bizType,
    suggestion: row.suggestion as 'Pass' | 'Review' | 'Block' | null,
    label: row.label,
    subLabel: row.subLabel,
    score: row.score,
    matchedRules: row.matchedRules,
    matchedTermsMasked: row.matchedTermsMasked,
    contentDigest: row.contentDigest,
    version: row.version,
    createdAt: row.createdAt,
  }
}

/**
 * 管理端评价图片待审（#694 M5c）。
 *
 * 队列只列「机器 REVIEW 且未人工结算、且已被某条评价引用」的图片；放行会搬迁字节并改写
 * 评价引用（都在 store 的同一事务里），本 service 只做游标/枚举映射与错误码收口。
 */
export function createReviewModerationService(options: {
  store: ReviewModerationStore
}): ReviewModerationService {
  const { store } = options
  return {
    async list(query) {
      const cursor = query.cursor
        ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.reviewModerationRecord)
        : null
      if (query.cursor && !cursor) {
        throw new ReviewModerationServiceError(
          'REVIEW_MODERATION_INVALID_CURSOR',
          422,
          '分页游标无效',
        )
      }

      const rows = await store.listPending({ before: cursor, limit: query.limit + 1 })
      const hasMore = rows.length > query.limit
      const items = rows.slice(0, query.limit)
      const last = items[items.length - 1]
      return ReviewModerationQueueResponseSchema.parse({
        items: items.map(toQueueItem),
        nextCursor:
          hasMore && last
            ? encodeCursor(last.createdAtCursor, last.id, PUBLIC_ID_PREFIX.reviewModerationRecord)
            : null,
      })
    },

    async decide(recordId, input, actorUserId) {
      let result: Awaited<ReturnType<ReviewModerationStore['decide']>>
      try {
        result = await store.decide({
          recordId,
          decision: input.decision,
          reason: input.reason,
          version: input.version,
          actorUserId,
        })
      } catch (error) {
        if (!(error instanceof ReviewModerationStoreError)) throw error
        if (error.code === 'MEDIA_CHANGED') {
          throw new ReviewModerationServiceError(
            'REVIEW_MODERATION_CONFLICT',
            409,
            '待审图片字节与审核记录不一致，不能放行；请刷新后重试',
          )
        }
        throw new ReviewModerationServiceError(
          'REVIEW_MODERATION_UNAVAILABLE',
          503,
          '图片存储暂时不可用，请稍后重试',
        )
      }

      if (result.outcome === 'not-found') {
        throw new ReviewModerationServiceError('REVIEW_MODERATION_NOT_FOUND', 404, '待审记录不存在')
      }
      if (result.outcome === 'conflict') {
        throw new ReviewModerationServiceError(
          'REVIEW_MODERATION_CONFLICT',
          409,
          '审核结论已被其他人处理或版本已变化，请刷新后重试',
        )
      }

      return ReviewModerationDecisionResponseSchema.parse({
        id: encodePublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, recordId),
        decision: input.decision,
        replayed: result.outcome === 'replayed',
      })
    },

    async findMedia(recordId) {
      return store.findMediaSnapshot(recordId)
    },
  }
}
