import type { Db } from '@fish/db/client'
import { userRestrictions } from '@fish/db/schema/governance'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * Governance store（#73 治理半场 PR3）：`user_restrictions` 的全部 SQL。
 *
 * 与 reports store 的分工：治理动作（下架 / 恢复 / 限制发布 / 封禁 / 解除）的
 * 「业务变更 + 审计写入」都写在调用方开的事务里，本文件只提供行级读写——
 * 因为事务边界必须由 service 掌握（一个动作里要同时动 listings / 限制 / 审计），
 * store 自己开事务就没法把三者绑在一起。
 */

export type GovernanceDbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

/** 限制表能被 service / 守卫 / 管理端复用的行形态。 */
export type RestrictionRow = {
  id: string
  userId: string
  /** 收窄成字面量联合（而不是 `string`）：service 与契约的类型检查才挡得住非法值。 */
  type: 'PUBLISH_RESTRICT' | 'BAN'
  status: 'ACTIVE' | 'LIFTED'
  reason: string
  actorUserId: string
  sourceReportId: string | null
  expiresAt: Date | null
  liftedAt: Date | null
  liftedBy: string | null
  createdAt: Date
}

/**
 * 写入口被限制挡住的范围。
 *
 * - `publish`：发布入口（建商品 / 改商品 / 重新上架 / 自行下架 / 媒体消息 / 发愿望及
 *   其改、关、成交）。`PUBLISH_RESTRICT` 与 `BAN` 都挡。
 * - `write`：其余写入口（留言、聊天、上传、资料、交易确认、AI 问答等）。只挡 `BAN`
 *   ——「限制发布」不扩大解释成禁言，否则管理员点一下「限制发布」就把用户变成全站哑巴，
 *   超出该动作的语义。挂载清单见 `app.ts`（每个 `guard:` 就是一处）。
 */
export type RestrictionScope = 'publish' | 'write'

type RestrictionType = RestrictionRow['type']

const SCOPE_TYPES: Record<RestrictionScope, RestrictionType[]> = {
  publish: ['PUBLISH_RESTRICT', 'BAN'],
  write: ['BAN'],
}

const RESTRICTION_COLUMNS = sql`id, user_id, type::text AS type, status::text AS status, reason,
  actor_user_id, source_report_id, expires_at, lifted_at, lifted_by, created_at`

/**
 * 「生效中」的**唯一** SQL 定义（#73 PR3 评审 M1）。
 *
 * `expires_at` 是惰性判断：到期行在表里仍是 `ACTIVE`，只有读到的这一刻才算失效。
 * 这带来一个必须统一口径的地方——service 的并发前置判定、写守卫、管理端列表、Overview
 * 计数、解除动作，五处只要有一处写成裸 `status = 'ACTIVE'`，就会出现「UI 说没有限制、
 * 接口说有」这种自相矛盾（Overview 虚高、误导性 409）。所以谓词只在这一处定义，
 * 其它位置一律引用它，不复制这段 SQL。
 *
 * 用 `now()` 而不是 JS `new Date()`：判定必须与 DB 同一时钟，否则 API 与 Postgres
 * 之间的时钟偏差会让 `expires_at` 边界行为不确定。
 */
export const ACTIVE_RESTRICTION_WHERE = sql`${userRestrictions.status} = 'ACTIVE'
  AND (${userRestrictions.expiresAt} IS NULL OR ${userRestrictions.expiresAt} > now())`

/** 「已过期但还挂着 ACTIVE」：占用唯一索引却已经不生效的行，见 `liftExpiredRestrictions`。 */
const EXPIRED_RESTRICTION_WHERE = sql`${userRestrictions.status} = 'ACTIVE'
  AND ${userRestrictions.expiresAt} IS NOT NULL
  AND ${userRestrictions.expiresAt} <= now()`

export interface GovernanceStore {
  /**
   * 该用户在指定范围内是否还有生效中的限制（未过期才算）。
   *
   * `expires_at` 是**惰性判断**：读时与 `now()` 比较，不引入定时任务把到期行刷成
   * `LIFTED`。代价是过期行在表里多躺一会儿，收益是没有任何后台设施依赖（#73 口径）。
   */
  hasActiveRestriction(userId: string, scope: RestrictionScope): Promise<boolean>

  /** 管理端用户详情用：该用户当前生效中的限制（时间倒序）。 */
  listActiveRestrictions(userId: string): Promise<RestrictionRow[]>

  /** 治理事务内插入一条 `ACTIVE` 限制。 */
  insertRestriction(
    tx: GovernanceDbTransaction,
    input: {
      userId: string
      type: 'PUBLISH_RESTRICT' | 'BAN'
      reason: string
      actorUserId: string
      sourceReportId: string | null
      expiresAt: Date | null
    },
  ): Promise<RestrictionRow>

  /**
   * 治理事务内把该用户**全部**生效中的限制改成 `LIFTED`，返回被解除的行。
   *
   * 只匹配真正生效中的行（`ACTIVE_RESTRICTION_WHERE`）：已过期的行**不**在这里解除，
   * 否则审计里会出现「解除了一条其实早已失效的限制」，把惰性过期和管理员动作混为一谈。
   *
   * 用「一条 UPDATE ... RETURNING」而不是逐条 UPDATE：两个管理员同时解除时，
   * 数据库只会让其中一个的 UPDATE 匹配到行，另一个拿到空集 → 409，
   * 不会出现"第一次解除成功、第二次把已解除的行再解除一遍"。
   */
  liftActiveRestrictions(
    tx: GovernanceDbTransaction,
    input: { userId: string; actorUserId: string; liftedAt: Date },
  ): Promise<RestrictionRow[]>

  /**
   * 治理事务内把指定 (用户, 类型) 的**已过期但仍为 ACTIVE** 的限制标成 `LIFTED`
   * （评审 M1 的修复），返回被清理的行数。
   *
   * 为什么需要它：部分唯一索引 `user_restrictions_active_user_type_uidx` 的谓词是
   * `status = 'ACTIVE'`，**无法引用 `now()`**（Postgres 要求索引谓词 immutable，而
   * `now()` 只是 stable）。于是一条已过期的行会继续占用唯一槽位——service 视角它
   * 已经不生效、可以加新限制，INSERT 却被索引拒绝，管理员拿到一句假的
   * 「该用户已有生效中的同类限制」，在 UI 上看到没有限制却点不出结果。
   *
   * 所以在插入前先把这些死行清掉：它们本就被读路径视为失效，这里只是把表里的状态
   * 与读路径的判定对齐。`lifted_by = NULL` 区分「到期自动失效」与「管理员解除」
   * （管理员解除一定写了 `lifted_by`），因此不需要为它补审计行——没有任何人做了这个动作。
   */
  liftExpiredRestrictions(
    tx: GovernanceDbTransaction,
    input: { userId: string; type: RestrictionType },
  ): Promise<number>
}

export function createSqlGovernanceStore(_db: Db): GovernanceStore {
  return {
    async hasActiveRestriction(userId, scope) {
      // 用 drizzle 的 `inArray` 而不是手写 `= ANY(${array})`：bun-sql 不会把 JS 数组
      // 展开成 PG 数组参数，直接绑会报
      // `op ANY/ALL (array) requires array on right side`（本仓库实测）。
      //
      // 走 typed builder 而不是裸 SQL，是为了让「生效中」的谓词与 `ACTIVE_RESTRICTION_WHERE`
      // 同源——这里曾经手写过 `new Date()` 比较，与 service 的 `now()` 不是同一个时钟。
      const rows = await _db
        .select({ id: userRestrictions.id })
        .from(userRestrictions)
        .where(
          and(
            eq(userRestrictions.userId, userId),
            // 直接把常量插进 typed `and(...)` 而不是重抄一遍谓词（对抗审查 M1）：
            // ACTIVE_RESTRICTION_WHERE 是 `sql` 片段，可以作为 and() 的参数展开，
            // `expires_at` 的边界若在这里漂移，写守卫就会与 Overview / 管理端列表口径不一。
            ACTIVE_RESTRICTION_WHERE,
            inArray(userRestrictions.type, SCOPE_TYPES[scope]),
          ),
        )
        .limit(1)
      return rows.length > 0
    },

    async listActiveRestrictions(userId) {
      const result = await _db.execute(sql`
        SELECT ${RESTRICTION_COLUMNS}
        FROM user_restrictions
        WHERE user_id = ${userId}
          AND ${ACTIVE_RESTRICTION_WHERE}
        ORDER BY created_at DESC, id DESC
      `)
      return rowsOf(result).map(restrictionFromRow)
    },

    async insertRestriction(tx, input) {
      const result = await tx.execute(sql`
        INSERT INTO user_restrictions
          (id, user_id, type, status, reason, actor_user_id, source_report_id, expires_at, created_at, updated_at)
        VALUES
          (gen_random_uuid(), ${input.userId}, ${input.type}::user_restriction_type, 'ACTIVE',
           ${input.reason}, ${input.actorUserId}, ${input.sourceReportId}, ${input.expiresAt},
           now(), now())
        RETURNING ${RESTRICTION_COLUMNS}
      `)
      const row = rowsOf(result)[0]
      if (!row) throw new Error('插入 user_restrictions 后没有 RETURNING 行（不可能分支）')
      return restrictionFromRow(row)
    },

    async liftActiveRestrictions(tx, input) {
      const result = await tx.execute(sql`
        UPDATE user_restrictions
        SET status = 'LIFTED', lifted_at = ${input.liftedAt}, lifted_by = ${input.actorUserId},
            updated_at = ${input.liftedAt}
        WHERE user_id = ${input.userId}
          AND ${ACTIVE_RESTRICTION_WHERE}
        RETURNING ${RESTRICTION_COLUMNS}
      `)
      return rowsOf(result).map(restrictionFromRow)
    },

    async liftExpiredRestrictions(tx, input) {
      const result = await tx.execute(sql`
        UPDATE user_restrictions
        SET status = 'LIFTED', lifted_at = now(), lifted_by = NULL, updated_at = now()
        WHERE user_id = ${input.userId}
          AND type::text = ${input.type}
          AND ${EXPIRED_RESTRICTION_WHERE}
        RETURNING id
      `)
      return rowsOf(result).length
    },
  }
}

/** 与 admin / reports store 相同的裸 SQL 行归一：`db.execute` 的返回形状是 `{ rows }`。 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function restrictionFromRow(row: Record<string, unknown>): RestrictionRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    // 断言而不是 runtime 校验：这两个列的合法值由 DB 枚举 / 迁移锁定，
    // 出现别的值说明有人在 DB 里手写了数据，属于运维事故而不是请求错误。
    type: String(row.type) as RestrictionRow['type'],
    status: String(row.status) as RestrictionRow['status'],
    reason: String(row.reason),
    actorUserId: String(row.actor_user_id),
    sourceReportId: row.source_report_id == null ? null : String(row.source_report_id),
    expiresAt: row.expires_at == null ? null : new Date(row.expires_at as string | Date),
    liftedAt: row.lifted_at == null ? null : new Date(row.lifted_at as string | Date),
    liftedBy: row.lifted_by == null ? null : String(row.lifted_by),
    createdAt: new Date(row.created_at as string | Date),
  }
}
