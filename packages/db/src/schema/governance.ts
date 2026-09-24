import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { reports } from './reports'
import { users } from './users'

/**
 * 限制类型（#73 治理半场 PR3）。
 *
 * - `PUBLISH_RESTRICT`：禁止一切写入口（发布商品、留言、发起会话 / 发消息、交易操作）。
 * - `BAN`：与 `PUBLISH_RESTRICT` 当前**行为等价**，另立一个值而不是复用，是因为两者的语义
 *   来源不同（封禁通常来自举报 / 严重违规，限制发布通常来自骚扰或刷单），且审计要能区分
 *   「这个用户是封禁还是限制」；将来若封禁要禁读，只需在守卫里加分支，不动数据。
 */
export const userRestrictionTypeEnum = pgEnum('user_restriction_type', ['PUBLISH_RESTRICT', 'BAN'])

/** 限制生命周期：ACTIVE（生效中）→ LIFTED（已解除）。只增不改，解除是写新状态而非删行。 */
export const userRestrictionStatusEnum = pgEnum('user_restriction_status', ['ACTIVE', 'LIFTED'])

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 用户限制（#73 治理半场 PR3，设计 §6）。
 *
 * 限制状态为什么住独立表而不是 `users` 加列、也不是从审计日志反推：
 * - **写请求每次都要读**，需要索引（`user_restrictions_user_type_status_idx`）；
 *   审计日志没有 (targetType, targetId) 之外的有效性维度，反推要全表扫。
 * - **解除是对称动作**：要记录谁解的、什么时候解的；审计日志只能记「解除了」，查不到
 *   「现在还有没有生效的限制」。
 * - `source_report_id` 让处罚可追溯回具体的举报单，审核时能看出这条限制是谁举报出来的。
 *
 * 约束与口径：
 * - `user_id` / `actor_user_id` / `lifted_by` 全部 `ON DELETE RESTRICT`：受限用户与操作者
 *   都不能被静默抹掉，否则「谁被限制了、谁封的」会随用户行一起消失。
 * - `source_report_id` 用 `ON DELETE SET NULL`：举报单的删除不属于本期范围，宽松处理，
 *   删了只是失去回链，不影响限制本身的有效性。
 * - 部分唯一索引 `user_restrictions_active_user_type_uidx`（WHERE status='ACTIVE'）：
 *   同一用户同一类型**只允许一条生效中的限制**，两个管理员同时封禁时后到的那条插不进去，
 *   作为「条件更新 → 409」之外的第二道并发兜底。
 * - CHECK `user_restrictions_no_self_restrict`：管理员不能限制自己。
 * - `expires_at` 惰性判断（读时与 now 比较），不引入定时任务；到期并未解除的限制在
 *   查询时按已失效处理，但行本身仍是 `ACTIVE`，直到有人显式解除或重新施加。
 */
export const userRestrictions = pgTable(
  'user_restrictions',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: userRestrictionTypeEnum('type').notNull(),
    status: userRestrictionStatusEnum('status').notNull().default('ACTIVE'),
    reason: text('reason').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sourceReportId: uuid('source_report_id').references(() => reports.id, { onDelete: 'set null' }),
    expiresAt: timestamptz('expires_at'),
    liftedAt: timestamptz('lifted_at'),
    liftedBy: uuid('lifted_by').references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    // 写守卫每次请求都按 (用户, 类型, 生效中) 查：没有这条索引等于每次全表扫。
    index('user_restrictions_user_type_status_idx').on(table.userId, table.type, table.status),
    // 管理端「生效中的限制」列表按时间倒序。
    index('user_restrictions_status_created_at_idx').on(table.status, table.createdAt),
    // 并发兜底：同一用户同一类型只允许一条生效中的限制。
    uniqueIndex('user_restrictions_active_user_type_uidx')
      .on(table.userId, table.type)
      .where(sql`${table.status} = 'ACTIVE'`),
    check('user_restrictions_no_self_restrict', sql`${table.userId} <> ${table.actorUserId}`),
  ],
)
