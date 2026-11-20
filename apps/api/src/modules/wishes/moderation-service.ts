import type {
  WishModerationDecisionInput,
  WishModerationQueueItem,
  WishModerationQueueQuery,
  WishModerationQueueResponse,
} from '@fish/contracts/wishes/moderation'
import { wishModerationQueueItemSchema } from '@fish/contracts/wishes/moderation'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { WishMatchQueue } from './match-queue'
import type { WishModerationStore } from './moderation-store'

export class WishModerationServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'WishModerationServiceError'
  }
}

export interface WishModerationService {
  list(query: WishModerationQueueQuery): Promise<WishModerationQueueResponse>
  decide(
    recordId: string,
    input: WishModerationDecisionInput,
    actorUserId: string,
  ): Promise<{ id: string; wishId: string; decision: 'ALLOW' | 'BLOCK'; replayed: boolean }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function encodeCursor(createdAt: Date | string, id: string): string {
  return `${new Date(createdAt).toISOString()}|${id}`
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = cursor.split('|')
  if (!iso || !id || !UUID.test(id)) {
    throw new WishModerationServiceError(
      'WISH_MODERATION_INVALID_CURSOR',
      422,
      '游标无效，请从第一页重新加载',
    )
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    throw new WishModerationServiceError(
      'WISH_MODERATION_INVALID_CURSOR',
      422,
      '游标无效，请从第一页重新加载',
    )
  }
  return { createdAt: date, id }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function payloadKeyword(row: { payload: { keyword?: unknown } }): string {
  return typeof row.payload.keyword === 'string' ? row.payload.keyword : ''
}

function payloadDescription(row: { payload: { description?: unknown } }): string | null {
  return typeof row.payload.description === 'string' ? row.payload.description : null
}

export function createWishModerationService({
  store,
  matchQueue,
}: {
  store: WishModerationStore
  matchQueue: WishMatchQueue
}): WishModerationService {
  return {
    async list(query) {
      const before = query.cursor ? decodeCursor(query.cursor) : undefined
      const rows = await store.listPending({ before, limit: query.limit + 1 })
      const page = rows.slice(0, query.limit)
      const items = page.map((row) => ({
        id: encodePublicId(PUBLIC_ID_PREFIX.wishModerationRecord, row.id),
        wishId: encodePublicId(PUBLIC_ID_PREFIX.wish, row.wish_id),
        contentVersion: Number(row.content_version),
        keyword: payloadKeyword(row),
        description: payloadDescription(row),
        currentKeyword: String(row.keyword),
        currentDescription: row.description ?? null,
        author: {
          id: encodePublicId(PUBLIC_ID_PREFIX.user, row.user_id),
          nickname: row.author_nickname ?? '用户',
        },
        machineDecision: row.machine_decision,
        provider: row.provider,
        policyVersion: row.policy_version,
        suggestion: row.suggestion ?? null,
        score: row.score ?? null,
        matchedRules: stringArray(row.matched_rules),
        matchedTermsMasked: stringArray(row.matched_terms_masked),
        status: row.status,
        decision: row.status === 'SETTLED' ? row.decision : null,
        version: Number(row.version),
        createdAt: new Date(row.created_at).toISOString(),
      }))
      const last = page.at(-1)
      return {
        items: wishModerationQueueItemSchema.array().parse(items),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null,
      }
    },

    async decide(recordId, input, actorUserId) {
      const result = await store.decide({
        recordId,
        decision: input.decision,
        reason: input.reason,
        version: input.version,
        actorUserId,
      })
      if (result.outcome === 'not-found') {
        throw new WishModerationServiceError('WISH_MODERATION_NOT_FOUND', 404, '待审记录不存在')
      }
      if (result.outcome === 'conflict') {
        throw new WishModerationServiceError(
          'WISH_MODERATION_CONFLICT',
          409,
          '审核结论已被其他人处理或版本已变化，请刷新后重试',
        )
      }
      // 放行后愿望才首次进入公开池/匹配：在事务提交后投递（重复投递幂等）。
      // replayed 也要补投：首次 applied 时若进程在提交后崩溃，重放是唯一的补救入口。
      if (result.decision === 'ALLOW') {
        await matchQueue.enqueue(result.wishId)
      }
      return {
        id: encodePublicId(PUBLIC_ID_PREFIX.wishModerationRecord, result.recordId),
        wishId: encodePublicId(PUBLIC_ID_PREFIX.wish, result.wishId),
        decision: result.decision,
        replayed: result.outcome === 'replayed',
      }
    },
  }
}
