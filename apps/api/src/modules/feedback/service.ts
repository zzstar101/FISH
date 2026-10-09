import {
  type AdminFeedbackItem,
  AdminFeedbackItemSchema,
  type AdminFeedbackListResponse,
  AdminFeedbackListResponseSchema,
  type AdminFeedbackQueueQuery,
  FEEDBACK_DAILY_LIMIT,
  type FeedbackCreateInput,
  type FeedbackCreateResponse,
  FeedbackCreateResponseSchema,
  type FeedbackErrorCode,
  type FeedbackHandleResult,
  type FeedbackListResponse,
  FeedbackListResponseSchema,
  type FeedbackMineQuery,
  FeedbackSchema,
} from '@fish/contracts/feedback/schema'
import type { SystemErrorCode } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor } from '../admin/cursor'
import type { AdminFeedbackRow, FeedbackRow, FeedbackStore } from './store'

/**
 * Feedback service（#463）：权限校验之后 + 数据层之前的业务编排。
 * 与 reports service 同一姿态：只从 store 产出的行构造 DTO，DTO 一律过契约 zod。
 */
export class FeedbackServiceError extends Error {
  constructor(
    readonly code: FeedbackErrorCode | SystemErrorCode,
    readonly status: 404 | 409 | 422 | 429,
    message: string,
  ) {
    super(message)
    this.name = 'FeedbackServiceError'
  }
}

function invalidCursor(): FeedbackServiceError {
  return new FeedbackServiceError('VALIDATION_FAILED', 422, 'cursor 无效')
}

function toFeedbackDto(row: FeedbackRow) {
  return FeedbackSchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.feedback, row.id),
    type: row.type,
    content: row.content,
    contact: row.contact,
    status: row.status,
    reply: row.reply,
    createdAt: row.createdAt.toISOString(),
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
  })
}

function toAdminItem(row: AdminFeedbackRow): AdminFeedbackItem {
  return AdminFeedbackItemSchema.parse({
    feedback: {
      ...toFeedbackDto(row.feedback),
      handlingNote: row.feedback.handlingNote,
      handledBy: row.handler
        ? { ...row.handler, id: encodePublicId(PUBLIC_ID_PREFIX.user, row.handler.id) }
        : null,
    },
    submitter: {
      ...row.submitter,
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.submitter.id),
    },
  })
}

function page<T, R extends { createdAtCursor: string; id: string }>(
  rows: T[],
  limit: number,
  key: (row: T) => R,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor(key(last).createdAtCursor, key(last).id, PUBLIC_ID_PREFIX.feedback)
        : null,
  }
}

export interface FeedbackService {
  createFeedback(userId: string, input: FeedbackCreateInput): Promise<FeedbackCreateResponse>
  listMine(userId: string, query: FeedbackMineQuery): Promise<FeedbackListResponse>
  listAdmin(query: AdminFeedbackQueueQuery): Promise<AdminFeedbackListResponse>
  getAdmin(feedbackId: string): Promise<AdminFeedbackItem>
  handleFeedback(input: {
    feedbackId: string
    actorUserId: string
    result: FeedbackHandleResult
    reply: string | null
    note: string
  }): Promise<void>
}

export function createFeedbackService(
  store: FeedbackStore,
  options: { dailyLimit?: number } = {},
): FeedbackService {
  const dailyLimit = options.dailyLimit ?? FEEDBACK_DAILY_LIMIT
  return {
    async createFeedback(userId, input) {
      const outcome = await store.createFeedback({
        userId,
        clientRequestId: input.clientRequestId,
        type: input.type,
        content: input.content,
        contact: input.contact ?? null,
        dailyLimit,
      })
      if (outcome.kind === 'rate-limited') {
        throw new FeedbackServiceError(
          'FEEDBACK_RATE_LIMITED',
          429,
          `24 小时内最多提交 ${dailyLimit} 条反馈，请稍后再试`,
        )
      }
      return FeedbackCreateResponseSchema.parse({
        feedback: toFeedbackDto(outcome.row),
        created: outcome.kind === 'created',
      })
    },

    async listMine(userId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.feedback) : null
      if (query.cursor && !cursor) throw invalidCursor()
      const rows = await store.listMine(userId, { cursor, limit: query.limit + 1 })
      const { items, nextCursor } = page(rows, query.limit, (row) => row)
      return FeedbackListResponseSchema.parse({ items: items.map(toFeedbackDto), nextCursor })
    },

    async listAdmin(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.feedback) : null
      if (query.cursor && !cursor) throw invalidCursor()
      const rows = await store.listAdmin({
        status: query.status,
        type: query.type,
        cursor,
        limit: query.limit + 1,
      })
      const { items, nextCursor } = page(rows, query.limit, (row) => row.feedback)
      return AdminFeedbackListResponseSchema.parse({ items: items.map(toAdminItem), nextCursor })
    },

    async getAdmin(feedbackId) {
      const row = await store.findAdmin(feedbackId)
      if (!row) throw new FeedbackServiceError('FEEDBACK_NOT_FOUND', 404, '反馈不存在')
      return toAdminItem(row)
    },

    async handleFeedback(input) {
      const result = await store.handleFeedback(input)
      if (result === 'not-found') {
        throw new FeedbackServiceError('FEEDBACK_NOT_FOUND', 404, '反馈不存在')
      }
      if (result === 'conflict') {
        throw new FeedbackServiceError('FEEDBACK_CONFLICT', 409, '该反馈已被处理')
      }
    },
  }
}
