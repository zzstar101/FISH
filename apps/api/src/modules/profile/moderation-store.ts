import type { ModerationDecision } from '@fish/contracts/moderation/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { users } from '@fish/db/schema/users'
import { eq, sql } from 'drizzle-orm'
import type { ModerationProviderName, ModerationSuggestion } from '../moderation/providers/types'

/**
 * 一次资料提交里**真正变化**的列（#694 M5）。
 *
 * 只放变化的列是刻意的：管理员放行时只写这些列，未提交的列保持库里现值，
 * 不会用「提交那一刻的旧快照」覆盖并发改过的字段。
 */
export type ProfileChange = {
  nickname?: string
  /** 显式 `null` = 用户清空了签名（与「没提交签名」不同，后者根本没有这个键）。 */
  signature?: string | null
  avatarUrl?: string
}

export const PROFILE_CHANGE_FIELDS = ['nickname', 'signature', 'avatarUrl'] as const
export type ProfileChangeField = (typeof PROFILE_CHANGE_FIELDS)[number]

/** 变化的字段名（稳定顺序），用于 422 明细与审计快照。 */
export function profileChangeFields(change: ProfileChange): ProfileChangeField[] {
  return PROFILE_CHANGE_FIELDS.filter((field) => change[field] !== undefined)
}

/**
 * jsonb payload → `ProfileChange`。
 *
 * 必须用 `in`/`!== undefined` 判断键是否存在：签名可以被清空成 `null`，
 * 只看取值分不出「没提交签名」与「提交了清空签名」。
 */
export type ProfileBase = { nickname: string; signature: string | null; avatarUrl: string | null }

/** 待审记录里的基线公开值；老记录没有该键时返回 null（保持兼容）。 */
export function decodeProfileBase(payload: unknown): ProfileBase | null {
  const source = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload
  if (typeof source !== 'object' || source === null) return null
  const base = (source as Record<string, unknown>).__base
  if (typeof base !== 'object' || base === null) return null
  const record = base as Record<string, unknown>
  return {
    nickname: typeof record.nickname === 'string' ? record.nickname : '',
    signature: typeof record.signature === 'string' ? record.signature : null,
    avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : null,
  }
}

export function decodeProfileChange(payload: unknown): ProfileChange {
  const source = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload
  if (typeof source !== 'object' || source === null) return {}
  const record = source as Record<string, unknown>
  const change: ProfileChange = {}
  if (typeof record.nickname === 'string') change.nickname = record.nickname
  if (typeof record.avatarUrl === 'string') change.avatarUrl = record.avatarUrl
  if ('signature' in record) {
    change.signature = typeof record.signature === 'string' ? record.signature : null
  }
  return change
}

export interface ProfileModerationQueueRow {
  id: string
  user_id: string
  /** 已解码的本次变更（只含变化的列）；「键存在且为 null」= 主动清空该列。 */
  payload: ProfileChange
  machine_decision: ModerationDecision
  decision: ModerationDecision
  status: 'PENDING' | 'SETTLED'
  provider: ModerationProviderName
  policy_version: string
  suggestion: ModerationSuggestion
  score: number | null
  matched_rules: unknown
  matched_terms_masked: unknown
  version: number
  created_at: Date | string
  current_nickname: string | null
  current_signature: string | null
  current_avatar_url: string | null
}

export interface ProfileModerationRecordInput {
  machineDecision: ModerationDecision
  decision: ModerationDecision
  provider: ModerationProviderName
  providerRequestId: string | null
  policyVersion: string
  suggestion: ModerationSuggestion
  label: string | null
  subLabel: string | null
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
}

export type ProfileModerationDecision =
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }
  | {
      outcome: 'applied' | 'replayed'
      recordId: string
      userId: string
      decision: 'ALLOW' | 'BLOCK'
      /** 本次提交涉及的字段（放行时切换的就是这些列）。 */
      fields: ProfileChangeField[]
    }

export interface ProfileModerationStore {
  listPending(input: {
    before?: { createdAt: Date; id: string }
    limit: number
  }): Promise<ProfileModerationQueueRow[]>
  decide(input: {
    recordId: string
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    version: number
    actorUserId: string
  }): Promise<ProfileModerationDecision>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const rows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/**
 * 资料待审队列（#694 M5 昵称/签名）。
 *
 * 公开值只落 `users`，本表只存待审快照，所以「待审内容不进任何公开投射」是结构保证，
 * 不依赖每个读路径额外过滤。放行在**一个事务**里同时改 `users` 与记录，CAS 版本防过期批准。
 */
export function createSqlProfileModerationStore(db: Db): ProfileModerationStore {
  return {
    async listPending({ before, limit }) {
      const cursor = before
        ? sql`AND (r.created_at, r.id) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`
        : sql``
      const result = await db.execute(sql`
        SELECT r.*, u.nickname AS current_nickname, u.signature AS current_signature,
               u.avatar_url AS current_avatar_url
        FROM profile_moderation_records r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = 'PENDING' ${cursor}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${limit}
      `)
      const rows = rowsOf(result)
      // 裸 SQL 的 jsonb 列回来的是文本，这里统一解码成对象：
      // 「键存在且为 null」是「主动清空」，不能与「没提交这一列」混为一谈。
      return rows.map((row) => ({
        ...(row as unknown as ProfileModerationQueueRow),
        payload: decodeProfileChange(row.payload),
      }))
    },

    async decide({ recordId, decision, reason, version, actorUserId }) {
      return db.transaction(async (tx) => {
        // 锁顺序固定为「users → 待审记录」：提交路径（queue/apply）也先锁 users 行，
        // 两边一致才不会在「用户正在提交」与「管理员正在放行」之间死锁。
        const header = rowsOf(
          await tx.execute(sql`
            SELECT user_id FROM profile_moderation_records WHERE id = ${recordId}::uuid
          `),
        )[0]
        if (!header) return { outcome: 'not-found' } as const
        const userId = String(header.user_id)

        const userLocked = rowsOf(
          await tx.execute(sql`
            SELECT id, nickname, signature, avatar_url, account_status
            FROM users WHERE id = ${userId}::uuid FOR UPDATE
          `),
        )
        if (userLocked.length === 0) return { outcome: 'not-found' } as const
        const currentUser = userLocked[0]
        if (!currentUser) return { outcome: 'not-found' } as const
        // 注销去标识化之后不允许再用旧待审值把昵称/签名/头像恢复公开。
        if (String(currentUser.account_status) === 'DELETED')
          return { outcome: 'not-found' } as const

        const locked = rowsOf(
          await tx.execute(sql`
            SELECT id, user_id, payload, status, decision, machine_decision, version
            FROM profile_moderation_records
            WHERE id = ${recordId}::uuid
            FOR UPDATE
          `),
        )[0]
        if (!locked) return { outcome: 'not-found' } as const

        const change = decodeProfileChange(locked.payload)
        const fields = profileChangeFields(change)

        const settledDecision =
          locked.decision === 'ALLOW' || locked.decision === 'BLOCK' ? locked.decision : null
        if (locked.status === 'SETTLED') {
          return settledDecision === decision
            ? { outcome: 'replayed' as const, recordId, userId, decision, fields }
            : { outcome: 'conflict' as const }
        }
        if (Number(locked.version) !== version) return { outcome: 'conflict' } as const

        const base = decodeProfileBase(locked.payload)
        if (base) {
          const current = {
            nickname: String(currentUser.nickname),
            signature: currentUser.signature === null ? null : String(currentUser.signature),
            avatarUrl: currentUser.avatar_url === null ? null : String(currentUser.avatar_url),
          }
          if (
            base.nickname !== current.nickname ||
            base.signature !== current.signature ||
            base.avatarUrl !== current.avatarUrl
          ) {
            // 入队后用户又改过公开值：这条判断已过期，绝不用它覆盖最新内容。
            return { outcome: 'conflict' as const }
          }
        }

        // 放行 = 一次性把这些列切到公开值（同一次 UPDATE，昵称与签名要么一起生效要么都不生效）。
        // 拒绝不动 users：旧公开值继续对外可见。
        if (decision === 'ALLOW' && fields.length > 0) {
          const patch: ProfileChange = {}
          if (change.nickname !== undefined) patch.nickname = change.nickname
          if (change.signature !== undefined) patch.signature = change.signature
          if (change.avatarUrl !== undefined) patch.avatarUrl = change.avatarUrl
          await tx.update(users).set(patch).where(eq(users.id, userId))
        }

        await tx.execute(sql`
          UPDATE profile_moderation_records
          SET decision = ${decision},
              status = 'SETTLED',
              reviewed_by = ${actorUserId}::uuid,
              reviewed_at = clock_timestamp(),
              review_note = ${reason},
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = ${recordId}::uuid
        `)

        // 审计只记状态与涉及字段，不复制待审正文（待审值可能是用户隐私或违规内容）。
        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId,
          action: 'PROFILE_MODERATION_DECISION',
          targetType: 'PROFILE_MODERATION_RECORD',
          targetId: recordId,
          before: jsonParam({
            status: 'PENDING',
            machineDecision: locked.machine_decision,
            version,
            fields,
          }),
          after: jsonParam({
            status: 'SETTLED',
            decision,
            version: version + 1,
            fields,
            applied: decision === 'ALLOW',
          }),
          reason,
        })

        return { outcome: 'applied' as const, recordId, userId, decision, fields }
      })
    },
  }
}

/**
 * 写入一条待审记录（供 profile store 在提交事务里调用）。
 *
 * `payload` 用 `JSON.stringify` 而不是 `jsonb_build_object`：列是**可选的子集**，
 * 三种列组合写不出固定 SQL，而 `JSON.stringify` 天然保留「键存在且为 null」的语义。
 */
export async function insertProfileModerationRecord(
  tx: Pick<Db, 'execute'>,
  userId: string,
  change: ProfileChange,
  record: ProfileModerationRecordInput,
  base?: ProfileBase,
): Promise<{ id: string; createdAt: Date }> {
  const inserted = rowsOf(
    await tx.execute(sql`
      INSERT INTO profile_moderation_records (
        id, user_id, payload,
        machine_decision, decision, status, provider, provider_request_id, policy_version,
        suggestion, label, sub_label, score, matched_rules, matched_terms_masked
      ) VALUES (
        ${newId()}, ${userId}::uuid, ${JSON.stringify(base ? { ...change, __base: base } : change)}::jsonb,
        ${record.machineDecision}, ${record.decision}, 'PENDING', ${record.provider},
        ${record.providerRequestId}, ${record.policyVersion}, ${record.suggestion},
        ${record.label}, ${record.subLabel}, ${record.score},
        ${JSON.stringify(record.matchedRules)}::jsonb,
        ${JSON.stringify(record.matchedTermsMasked)}::jsonb
      )
      RETURNING id, created_at
    `),
  )[0]
  if (!inserted) throw new Error('写入资料待审记录失败')
  const createdAt = inserted.created_at
  return {
    id: String(inserted.id),
    createdAt: createdAt instanceof Date ? createdAt : new Date(String(createdAt)),
  }
}
