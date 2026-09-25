import type { AdminAuditAction, AdminAuditTargetType } from '@fish/contracts/admin/schema'
import type {
  GovernanceErrorCode,
  GovernanceLiftRestrictionInput,
  GovernanceListingDelistInput,
  GovernanceListingRestoreInput,
  GovernanceRestrictInput,
  GovernanceRestriction,
  GovernanceResult,
} from '@fish/contracts/governance/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { jobs } from '@fish/db/schema/jobs'
import { sql } from 'drizzle-orm'
import { isUniqueViolation } from '../auth/unique'
import { lockUserWrites } from './lock'
import type { GovernanceDbTransaction, GovernanceStore, RestrictionRow } from './store'
import { ACTIVE_RESTRICTION_WHERE } from './store'

/**
 * Governance service（#73 治理半场 PR3）：五个治理动作的业务与事务边界。
 *
 * 三条不变式（对应验收标准）：
 * 1. **业务变更与审计写入在同一事务里**——审计 INSERT 用内联 `tx.insert`，不经过任何
 *    「先提交业务、再补一条审计」的辅助函数。人为让审计写入失败（触发器等）时整个事务
 *    回滚，商品 / 限制状态不会只改一半。
 * 2. **并发有确定结果**——事务开头 `SELECT ... FOR UPDATE` 锁住目标行，把「读状态 → 判
 *    断 → 改状态」串行化；后到的管理员看到前一个已提交的状态 → 409，而不是两次都成功。
 *    限制类动作额外有部分唯一索引 `user_restrictions_active_user_type_uidx` 兜底。
 * 3. **治理动作与举报处理分离**——这里不读也不写 `reports` 的状态；`sourceReportId`
 *    只作为一条外链存进审计（便于事后追「这次封禁是因为哪张举报单」），
 *    处理举报仍然是 `REPORT_DECISION` 那条独立路径。
 */

/**
 * 治理失败。全部是可预期的业务失败，不该变成 500。
 *
 * `status` 收窄成字面量联合（而不是 `number`），这样 router 里 `c.json(..., error.status)`
 * 直接满足 Hono 的 `ContentfulStatusCode`；与 ReportServiceError / AdminError 同一取舍。
 */
export class GovernanceServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: GovernanceErrorCode | 'VALIDATION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'GovernanceServiceError'
  }
}

export type GovernanceService = {
  /** 下架商品：`status = OFFLINE` + `moderation_status = BLOCKED`，卖家无法自行恢复。 */
  delistListing(
    actorUserId: string,
    listingId: string,
    input: GovernanceListingDelistInput,
  ): Promise<GovernanceResult>
  /**
   * 恢复商品：目标 `status` 取**下架时写进审计快照的 `prior_listing_status`**，
   * 而不是无脑 `ACTIVE`——卖家下架（`OFFLINE`）的商品被管理员误下架后再恢复，
   * 回到 `ACTIVE` 等于替卖家重新上架，篡改了他的意图。
   */
  restoreListing(
    actorUserId: string,
    listingId: string,
    input: GovernanceListingRestoreInput,
  ): Promise<GovernanceResult>
  /** 限制发布（`PUBLISH_RESTRICT`）：挡发布入口，不禁言、不封号。 */
  restrictPublish(
    actorUserId: string,
    userId: string,
    input: GovernanceRestrictInput,
  ): Promise<GovernanceResult>
  /** 封禁（`BAN`）：当前只禁写（发布 / 留言 / 聊天），读保持开放（Q6）。 */
  ban(
    actorUserId: string,
    userId: string,
    input: GovernanceRestrictInput,
  ): Promise<GovernanceResult>
  /** 解除该用户**全部**生效中的限制（一条端点处理多种限制，避免"解了封禁忘了限制发布"）。 */
  liftRestriction(
    actorUserId: string,
    userId: string,
    input: GovernanceLiftRestrictionInput,
  ): Promise<GovernanceResult>
}

export function createGovernanceService(options: {
  db: Db
  store: GovernanceStore
}): GovernanceService {
  const { db, store } = options

  /** Only an existing report about this listing/user (or the user's listing) can source a penalty. */
  async function requireSourceReport(
    tx: GovernanceDbTransaction,
    sourceReportId: string | null | undefined,
    target: { type: 'LISTING' | 'USER'; id: string },
  ): Promise<string | null> {
    if (!sourceReportId) return null
    const [row] = rowsOf(
      await tx.execute(sql`
      SELECT r.target_type::text AS target_type, r.target_id, l.seller_id
      FROM reports r
      LEFT JOIN listings l ON r.target_type = 'LISTING' AND l.id = r.target_id
      WHERE r.id = ${sourceReportId} LIMIT 1
    `),
    )
    if (!row) {
      throw new GovernanceServiceError(
        404,
        'GOVERNANCE_SOURCE_REPORT_NOT_FOUND',
        '关联的举报单不存在',
      )
    }
    const related =
      target.type === 'LISTING'
        ? row.target_type === 'LISTING' && row.target_id === target.id
        : (row.target_type === 'USER' && row.target_id === target.id) ||
          (row.target_type === 'LISTING' && row.seller_id === target.id)
    if (!related) {
      throw new GovernanceServiceError(
        422,
        'GOVERNANCE_SOURCE_REPORT_MISMATCH',
        '关联举报目标与治理目标不符',
      )
    }
    return sourceReportId
  }

  /** 先与所有受保护写请求串行化，再锁用户行与其它治理动作串行化。 */
  async function lockUser(tx: GovernanceDbTransaction, userId: string): Promise<void> {
    await tx.execute(lockUserWrites(userId))
    const result = await tx.execute(sql`
      SELECT id FROM users WHERE id = ${userId} FOR UPDATE
    `)
    if (rowsOf(result).length === 0) {
      throw new GovernanceServiceError(404, 'GOVERNANCE_TARGET_NOT_FOUND', '用户不存在')
    }
  }

  async function lockListing(tx: GovernanceDbTransaction, listingId: string): Promise<ListingLock> {
    const result = await tx.execute(sql`
      SELECT status::text AS status, moderation_status::text AS moderation_status,
             governance_delisted_at
      FROM listings WHERE id = ${listingId}
      FOR UPDATE
    `)
    const row = rowsOf(result)[0]
    if (!row) {
      throw new GovernanceServiceError(404, 'GOVERNANCE_TARGET_NOT_FOUND', '商品不存在')
    }
    return {
      status: String(row.status),
      moderationStatus: String(row.moderation_status),
      governanceDelistedAt: row.governance_delisted_at
        ? new Date(String(row.governance_delisted_at))
        : null,
    }
  }

  /**
   * 限制类动作的公共路径：锁用户 → 校验不自我限制 → 建限制 → 写审计。
   *
   * 并发语义：`SELECT ... FOR UPDATE` 已把同一用户的动作串行化，所以这里的
   * 「已有同类型 ACTIVE 限制 → 409」在锁内判定，不会被另一个管理员插队；
   * 部分唯一索引是这条判定之外的 DB 兜底（例如绕过 service 直连 DB 的写入）。
   */
  async function applyRestriction(
    actorUserId: string,
    userId: string,
    input: GovernanceRestrictInput & { type: 'PUBLISH_RESTRICT' | 'BAN' },
  ): Promise<GovernanceResult> {
    if (userId === actorUserId) {
      throw new GovernanceServiceError(422, 'GOVERNANCE_SELF_TARGET', '不能对自己执行治理操作')
    }
    return db.transaction(async (tx) => {
      await lockUser(tx, userId)
      const sourceReportId = await requireSourceReport(tx, input.sourceReportId, {
        type: 'USER',
        id: userId,
      })
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
      if (expiresAt !== null) {
        if (Number.isNaN(expiresAt.getTime())) {
          throw new GovernanceServiceError(422, 'VALIDATION_FAILED', 'expiresAt 不是合法时间')
        }
        // The row must be effective when committed. Use the DB clock after acquiring the
        // user lock, not a possibly stale transaction start or an API host's skewed clock.
        const expiry = rowsOf(
          await tx.execute(sql`
          SELECT ${expiresAt}::timestamptz <= clock_timestamp() AS expired
        `),
        )[0]
        if (expiry?.expired) {
          throw new GovernanceServiceError(422, 'VALIDATION_FAILED', 'expiresAt 必须晚于当前时间')
        }
      }

      const active = await tx.execute(sql`
        SELECT id FROM user_restrictions
        WHERE user_id = ${userId}
          AND type::text = ${input.type}
          AND ${ACTIVE_RESTRICTION_WHERE}
        LIMIT 1
      `)
      if (rowsOf(active).length > 0) {
        throw new GovernanceServiceError(
          409,
          'GOVERNANCE_CONFLICT',
          '该用户已有生效中的同类限制，请先解除',
        )
      }

      // 清理「已过期但仍占着唯一索引」的死行（评审 M1）。必须在 INSERT 之前：
      // 部分唯一索引的谓词写不了 `now()`，过期行会继续占住 (user, type) 槽位，
      // 让这次 INSERT 撞 23505，把一句假的「已有生效中的同类限制」返回给管理员。
      await store.liftExpiredRestrictions(tx, { userId, type: input.type })

      let restriction: RestrictionRow
      try {
        restriction = await store.insertRestriction(tx, {
          userId,
          type: input.type,
          reason: input.reason,
          actorUserId,
          sourceReportId,
          expiresAt,
        })
      } catch (error) {
        // 并发兜底：另一个管理员刚刚提交了同类型限制（部分唯一索引拒绝本次 INSERT）。
        if (isUniqueViolation(error)) {
          throw new GovernanceServiceError(
            409,
            'GOVERNANCE_CONFLICT',
            '该用户已有生效中的同类限制，请先解除',
          )
        }
        throw error
      }

      await writeAudit(tx, {
        actorUserId,
        action: input.type === 'BAN' ? 'USER_BANNED' : 'USER_RESTRICTED',
        targetType: 'USER_RESTRICTION',
        targetId: restriction.id,
        before: { status: 'NONE' },
        after: {
          type: input.type,
          status: 'ACTIVE',
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          sourceReportId,
        },
        reason: input.reason,
      })

      return {
        action: input.type === 'BAN' ? 'USER_BANNED' : 'USER_RESTRICTED',
        targetType: 'USER_RESTRICTION',
        targetId: restriction.id,
        listingStatus: null,
        restriction: toContractRestriction(restriction),
      }
    })
  }

  return {
    async delistListing(actorUserId, listingId, input) {
      return db.transaction(async (tx) => {
        const sourceReportId = await requireSourceReport(tx, input.sourceReportId, {
          type: 'LISTING',
          id: listingId,
        })
        const current = await lockListing(tx, listingId)
        if (current.moderationStatus !== 'APPROVED') {
          throw new GovernanceServiceError(
            409,
            'GOVERNANCE_CONFLICT',
            '商品待审或已被屏蔽，不能通过治理动作下架',
          )
        }

        // 条件更新：已经是 BLOCKED 就一行都不改（并发下第二个管理员拿到 0 行 → 409）。
        // 上面的前置判定在 `FOR UPDATE` 锁内，正常情况下已经拦住并发；这里再挡一次是为了
        // 不依赖锁的正确性。
        const updated = await tx.execute(sql`
          UPDATE listings
          SET status = 'OFFLINE', moderation_status = 'BLOCKED',
              governance_delisted_at = now(), updated_at = now()
          WHERE id = ${listingId} AND moderation_status = 'APPROVED'
          RETURNING ${LISTING_STATE_COLUMNS}
        `)
        if (rowsOf(updated).length === 0) {
          throw new GovernanceServiceError(409, 'GOVERNANCE_CONFLICT', '商品已被下架或屏蔽')
        }

        // 下架会改变匹配结果（商品离开 ACTIVE），按 listings store `setStatus` 的同一条
        // 规则投 `MATCH_LISTING`（引擎对非 ACTIVE 是 no-op，投了无害；漏投会让缓存里的
        // 匹配结果继续引用一个已不公开的商品）。
        await enqueueMatchJob(tx, listingId)

        await writeAudit(tx, {
          actorUserId,
          action: 'LISTING_DELISTED',
          targetType: 'LISTING',
          targetId: listingId,
          before: {
            listingStatus: current.status,
            moderationStatus: current.moderationStatus,
          },
          after: {
            listingStatus: 'OFFLINE',
            moderationStatus: 'BLOCKED',
            // restore 的还原依据：下架这一刻卖家把商品放在什么状态。
            priorListingStatus: current.status,
            sourceReportId,
          },
          reason: input.reason,
        })

        return {
          action: 'LISTING_DELISTED',
          targetType: 'LISTING',
          targetId: listingId,
          listingStatus: 'OFFLINE',
          restriction: null,
        }
      })
    },

    async restoreListing(actorUserId, listingId, input) {
      return db.transaction(async (tx) => {
        const sourceReportId = await requireSourceReport(tx, input.sourceReportId, {
          type: 'LISTING',
          id: listingId,
        })
        const current = await lockListing(tx, listingId)
        // 只恢复**治理下架**（评审 M3）。
        //
        // 判 `governance_delisted_at` 而不是「moderation_status = BLOCKED」：BLOCKED 有
        // 两个写入方——治理 delist（`governance_delisted_at` 一并写）与审核引擎
        // （`listing_moderation_records` 里一条 decision='BLOCKED'，没有标记）。
        // 引擎屏蔽是「内容违规」，它的解除路径是人工审核
        // （`decideWithin` 处理 moderation_status='REVIEW'）或卖家改完重新送审；
        // 治理 restore 是「管理员下架下错了」，目标和依据都不同。
        //
        // 合在一起会怎样：restore 把引擎屏蔽的商品置成 APPROVED 直接放回公开列表，
        // 等于用治理端点绕过了审核引擎，而审计里只看得到一条 LISTING_RESTORED。
        // 这里也不会误伤「引擎屏蔽后又治理下架」：delist 入口拒绝 BLOCKED 的商品，
        // 所以治理下架时 `moderation_status` 必不是引擎写的那一种。
        if (current.governanceDelistedAt === null) {
          throw new GovernanceServiceError(
            409,
            'GOVERNANCE_CONFLICT',
            current.moderationStatus === 'BLOCKED'
              ? '商品被审核引擎屏蔽，请通过人工审核处理'
              : '商品未被下架，无需恢复',
          )
        }

        const prior = await priorListingStatus(tx, listingId)
        let restoredStatus = prior.status
        if (prior.status === 'RESERVED') {
          // A transaction may have reached its terminal state while governance kept the
          // listing OFFLINE/BLOCKED. The listing lock serializes this read with the
          // transaction's listing update without locking its transaction row (which would
          // invert the transaction -> listing lock order and deadlock).
          const [latest] = rowsOf(
            await tx.execute(sql`
            SELECT status::text AS status FROM transactions
            WHERE listing_id = ${listingId}
            ORDER BY created_at DESC, id DESC LIMIT 1
          `),
          )
          if (latest?.status === 'CANCELLED') restoredStatus = 'ACTIVE'
          if (latest?.status === 'COMPLETED') restoredStatus = 'SOLD'
        }
        const updated = await tx.execute(sql`
          UPDATE listings
          SET status = ${restoredStatus}::listing_status,
              moderation_status = ${prior.moderationStatus}::listing_moderation_status,
              governance_delisted_at = NULL, moderated_at = now(), updated_at = now()
          WHERE id = ${listingId} AND governance_delisted_at IS NOT NULL
          RETURNING ${LISTING_STATE_COLUMNS}
        `)
        if (rowsOf(updated).length === 0) {
          throw new GovernanceServiceError(409, 'GOVERNANCE_CONFLICT', '商品未被下架，无需恢复')
        }

        // 恢复成 ACTIVE 时必须重算匹配：下架期间新建的愿望要靠这条 job 才能匹配上它。
        await enqueueMatchJob(tx, listingId)

        await writeAudit(tx, {
          actorUserId,
          action: 'LISTING_RESTORED',
          targetType: 'LISTING',
          targetId: listingId,
          before: {
            listingStatus: current.status,
            moderationStatus: current.moderationStatus,
          },
          after: {
            listingStatus: restoredStatus,
            moderationStatus: prior.moderationStatus,
            sourceReportId,
          },
          reason: input.reason,
        })

        return {
          action: 'LISTING_RESTORED',
          targetType: 'LISTING',
          targetId: listingId,
          listingStatus: restoredStatus,
          restriction: null,
        }
      })
    },

    restrictPublish(actorUserId, userId, input) {
      return applyRestriction(actorUserId, userId, { ...input, type: 'PUBLISH_RESTRICT' })
    },

    ban(actorUserId, userId, input) {
      return applyRestriction(actorUserId, userId, { ...input, type: 'BAN' })
    },

    async liftRestriction(actorUserId, userId, input) {
      if (userId === actorUserId) {
        throw new GovernanceServiceError(422, 'GOVERNANCE_SELF_TARGET', '不能对自己执行治理操作')
      }
      return db.transaction(async (tx) => {
        await lockUser(tx, userId)
        const sourceReportId = await requireSourceReport(tx, input.sourceReportId, {
          type: 'USER',
          id: userId,
        })
        const liftedAt = new Date()
        const lifted = await store.liftActiveRestrictions(tx, {
          userId,
          actorUserId,
          liftedAt,
        })
        const firstLifted = lifted[0]
        // 空集 = 没有生效中的限制（另一个管理员刚刚解除过一次）。
        // 这里同时消除 `lifted.length` 判断与索引访问之间的缝隙：
        // `noUncheckedIndexedAccess` 下 `lifted[0]` 也是 `undefined`，用一次判空收口。
        if (!firstLifted) {
          throw new GovernanceServiceError(
            409,
            'GOVERNANCE_CONFLICT',
            '该用户没有生效中的限制，无需解除',
          )
        }

        // 每条被解除的限制各写一条审计：`USER_RESTRICTION` 作为审计目标的意义就是
        // 「同一用户多次限制时每条都能单独追」。action 按解除的类型区分（解封禁 /
        // 解限制发布），审计筛选时不必再解析 payload。
        for (const restriction of lifted) {
          const unbanning = restriction.type === 'BAN'
          await writeAudit(tx, {
            actorUserId,
            action: unbanning ? 'USER_UNBANNED' : 'USER_RESTRICTION_LIFTED',
            targetType: 'USER_RESTRICTION',
            targetId: restriction.id,
            before: { type: restriction.type, status: 'ACTIVE' },
            after: { type: restriction.type, status: 'LIFTED', sourceReportId },
            reason: input.reason,
          })
        }

        // 解除后用户重新可写，但没有商品状态变化，不需要重算匹配——这里不投 job。

        return {
          action: lifted.some((row) => row.type === 'BAN')
            ? 'USER_UNBANNED'
            : 'USER_RESTRICTION_LIFTED',
          targetType: 'USER_RESTRICTION',
          targetId: firstLifted.id,
          listingStatus: null,
          restriction: toContractRestriction(firstLifted),
        }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

type ListingLock = {
  status: string
  moderationStatus: string
  /** 非 null = 已经被治理下架过（与审核引擎的 BLOCKED 区分开）。 */
  governanceDelistedAt: Date | null
}

/**
 * 限制行 → 契约 DTO。
 *
 * 契约的时间字段是 `z.iso.datetime()`（字符串），而 store 交给 service 的是 `Date`；
 * 转换只发生在这一处，router / 前端因此永远拿到同一种形状。
 */
function toContractRestriction(row: RestrictionRow): GovernanceRestriction {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    status: row.status,
    reason: row.reason,
    actorUserId: row.actorUserId,
    sourceReportId: row.sourceReportId,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    liftedAt: row.liftedAt ? row.liftedAt.toISOString() : null,
    liftedBy: row.liftedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/** 列片段：给 UPDATE / SELECT 的 RETURNING 用，避免在两处各写一份。 */
const LISTING_STATE_COLUMNS = sql`status::text AS status, moderation_status::text AS moderation_status, governance_delisted_at`

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

/**
 * 从最近一次 `LISTING_DELISTED` 审计行里取下架前的 `listing_status`。
 *
 * 取不到（审计被清 / 该商品是被审核引擎而不是治理下架的）时退回 `ACTIVE`：
 * 恢复本身已经是管理员的显式动作，"回到可售"是这个动作的默认含义。
 *
 * `ORDER BY ... DESC, id DESC` 的第二排序键必须有：同一次下架的同秒重放（幂等键重放、
 * 两个管理员几乎同时操作）会让 `created_at` 打平，没有第二键时先后顺序随机，
 * 「还原到哪个 prior」就不确定了。
 */
async function priorListingStatus(
  tx: GovernanceDbTransaction,
  listingId: string,
): Promise<{
  status: 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE'
  moderationStatus: 'APPROVED' | 'REVIEW'
}> {
  const result = await tx.execute(sql`
    SELECT after->>'priorListingStatus' AS prior,
           before->>'moderationStatus' AS prior_moderation
    FROM admin_audit_logs
    WHERE action = 'LISTING_DELISTED'
      AND target_type = 'LISTING'
      AND target_id = ${listingId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
  const row = rowsOf(result)[0]
  const status = row?.prior
  // Missing/corrupt audit must not restore an unknown state as publicly APPROVED.
  if (status !== 'ACTIVE' && status !== 'RESERVED' && status !== 'SOLD' && status !== 'OFFLINE') {
    throw new GovernanceServiceError(409, 'GOVERNANCE_CONFLICT', '下架审计缺失，无法安全恢复')
  }
  return { status, moderationStatus: row?.prior_moderation === 'APPROVED' ? 'APPROVED' : 'REVIEW' }
}

/** 与 listings store `enqueueMatchJobWith` 同一条规则：改商品状态就重算匹配。 */
async function enqueueMatchJob(executor: Pick<Db, 'insert'>, listingId: string): Promise<void> {
  await executor.insert(jobs).values({
    id: newId(),
    type: 'MATCH_LISTING',
    payload: jsonParam({ listingId }),
  })
}

/**
 * 审计写入：**内联在调用方的事务里**（调用方传 `tx`，本函数不开连接、不开事务）。
 *
 * 刻意不做成「共享 audit store」——那种形态很容易长出「helper 用 `db` 而不是 `tx`」
 * 的变体，于是业务已提交、审计才失败，回滚不了（#73 PR1 删掉的 `insertAuditLog` 正是
 * 这个形状的死代码）。审计失败时异常从 `tx` 里抛出，整个事务回滚，商品 / 限制状态
 * 不会只改一半（验收标准第 3 条）。
 */
async function writeAudit(
  tx: GovernanceDbTransaction,
  values: {
    actorUserId: string
    action: AdminAuditAction
    targetType: AdminAuditTargetType
    targetId: string
    before: unknown
    after: unknown
    reason: string
  },
): Promise<void> {
  await tx.insert(adminAuditLogs).values({
    id: newId(),
    actorUserId: values.actorUserId,
    action: values.action,
    targetType: values.targetType,
    targetId: values.targetId,
    before: jsonParam(values.before),
    after: jsonParam(values.after),
    reason: values.reason,
    // 治理不走 Idempotency-Key 幂等（并发靠 `FOR UPDATE` + 409），所以 request_id 为空。
    requestId: null,
  })
}
