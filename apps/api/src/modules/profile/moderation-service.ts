import type {
  ProfileModerationDecisionInput,
  ProfileModerationQueueItem,
  ProfileModerationQueueQuery,
  ProfileModerationQueueResponse,
} from '@fish/contracts/profile/moderation'
import { profileModerationQueueItemSchema } from '@fish/contracts/profile/moderation'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { decodeProfileChange, type ProfileModerationStore } from './moderation-store'

export class ProfileModerationServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'ProfileModerationServiceError'
  }
}

export interface ProfileModerationService {
  list(query: ProfileModerationQueueQuery): Promise<ProfileModerationQueueResponse>
  decide(
    recordId: string,
    input: ProfileModerationDecisionInput,
    actorUserId: string,
  ): Promise<{ id: string; userId: string; decision: 'ALLOW' | 'BLOCK'; replayed: boolean }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function encodeCursor(createdAt: Date | string, id: string): string {
  return `${new Date(createdAt).toISOString()}|${id}`
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = cursor.split('|')
  if (!iso || !id || !UUID.test(id)) {
    throw new ProfileModerationServiceError(
      'PROFILE_MODERATION_INVALID_CURSOR',
      422,
      '游标无效，请从第一页重新加载',
    )
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    throw new ProfileModerationServiceError(
      'PROFILE_MODERATION_INVALID_CURSOR',
      422,
      '游标无效，请从第一页重新加载',
    )
  }
  return { createdAt: date, id }
}

/**
 * jsonb 数组列 → `string[]`。
 *
 * 裸 SQL（`db.execute`）回来的 jsonb 是**文本**而不是已解析的数组，直接 `Array.isArray`
 * 会让机审命中的规则/词表在管理端一片空白，所以这里两种情况都要吃。
 */
function stringArray(value: unknown): string[] {
  const source =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown
          } catch {
            return null
          }
        })()
      : value
  return Array.isArray(source)
    ? source.filter((item): item is string => typeof item === 'string')
    : []
}

/**
 * 资料待审队列（#694 M5 昵称/签名）。
 *
 * 队列项同时给出「待审值」与「当前公开值」：管理员要能判断这次提交到底改了什么、
 * 放行后会变成什么样。当前值走 `publicAvatarUrl` 降级，库里脏头像不会让整个队列 500。
 */
export function createProfileModerationService({
  store,
}: {
  store: ProfileModerationStore
}): ProfileModerationService {
  return {
    async list(query) {
      const before = query.cursor ? decodeCursor(query.cursor) : undefined
      const rows = await store.listPending({ before, limit: query.limit + 1 })
      const page = rows.slice(0, query.limit)
      const items: ProfileModerationQueueItem[] = page.map((row) => {
        const change = decodeProfileChange(row.payload)
        return {
          id: encodePublicId(PUBLIC_ID_PREFIX.profileModerationRecord, row.id),
          userId: encodePublicId(PUBLIC_ID_PREFIX.user, row.user_id),
          nickname: change.nickname ?? null,
          signature: change.signature !== undefined ? change.signature : null,
          avatarUrl: change.avatarUrl === undefined ? null : publicAvatarUrl(change.avatarUrl),
          fields: (['nickname', 'signature', 'avatarUrl'] as const).filter(
            (field) => change[field] !== undefined,
          ),
          currentNickname: row.current_nickname ?? '用户',
          currentSignature: row.current_signature ?? null,
          currentAvatarUrl: publicAvatarUrl(row.current_avatar_url),
          // 昵称的历史引用口径与 users 一致：队列里的作者就是记录所属用户自己。
          author: {
            id: encodePublicId(PUBLIC_ID_PREFIX.user, row.user_id),
            nickname: row.current_nickname ?? '用户',
          },
          machineDecision: row.machine_decision,
          provider: row.provider,
          policyVersion: row.policy_version,
          suggestion: row.suggestion ?? null,
          score: row.score ?? null,
          matchedRules: stringArray(row.matched_rules),
          matchedTermsMasked: stringArray(row.matched_terms_masked),
          status: row.status,
          // SETTLED 的记录一定带人工结论（ALLOW/BLOCK）；REVIEW 是机审档位，不能当人工结论下发。
          decision:
            row.status === 'SETTLED' && (row.decision === 'ALLOW' || row.decision === 'BLOCK')
              ? row.decision
              : null,
          version: Number(row.version),
          createdAt: new Date(row.created_at).toISOString(),
        }
      })
      const last = page.at(-1)
      return {
        items: profileModerationQueueItemSchema.array().parse(items),
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
        throw new ProfileModerationServiceError(
          'PROFILE_MODERATION_NOT_FOUND',
          404,
          '待审记录不存在',
        )
      }
      if (result.outcome === 'conflict') {
        throw new ProfileModerationServiceError(
          'PROFILE_MODERATION_CONFLICT',
          409,
          '审核结论已被其他人处理或版本已变化，请刷新后重试',
        )
      }
      // 放行切换的公开值在同一事务里已经写好；`replayed` 也照常返回（端上按幂等处理），
      // 不需要额外的投递动作——与许愿不同，资料放行不触发匹配/embedding 之类的外部副作用。
      return {
        id: encodePublicId(PUBLIC_ID_PREFIX.profileModerationRecord, result.recordId),
        userId: encodePublicId(PUBLIC_ID_PREFIX.user, result.userId),
        decision: result.decision,
        replayed: result.outcome === 'replayed',
      }
    },
  }
}
