import { index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { users } from './users'

/** 高风险管理操作的类型（设计 §5 DB CHANGE REQUEST B）。 */
export const adminAuditActionEnum = pgEnum('admin_audit_action', [
  'ADMIN_PROMOTED',
  'MODERATION_DECISION',
  // #73 治理半场 PR2：处理举报（受理 / 驳回）——只写结果，不动商品或用户。
  'REPORT_DECISION',
  // #73 治理半场 PR3：五个治理端点各一个 action（细粒度，审计筛选项）。
  'LISTING_DELISTED',
  'LISTING_RESTORED',
  'USER_RESTRICTED',
  'USER_RESTRICTION_LIFTED',
  'USER_BANNED',
  'USER_UNBANNED',
])

/** 审计目标类型。审核决定以 moderation record 为审计目标；举报以举报单为审计目标。 */
export const adminAuditTargetTypeEnum = pgEnum('admin_audit_target_type', [
  'USER',
  'LISTING',
  'MODERATION_RECORD',
  'REPORT',
  // #73 治理半场 PR3：限制 / 封禁的审计目标是限制记录本身（不是用户），
  // 这样同一用户被多次限制时每条都有独立可查的审计目标。
  'USER_RESTRICTION',
])

/**
 * Admin 审计日志（#73）：高风险管理操作的不可抵赖记录。
 *
 * - **只增不删不改**：应用层不提供任何更新 / 删除接口（设计 §4.6 / §8）；本表也没有
 *   `updated_at`（只有 `created_at`）。
 * - `before` / `after` 是脱敏快照：禁止保存密码哈希、Cookie、完整学号等敏感信息
 *   （设计 §8），写入口（service）负责脱敏。
 * - `actor_user_id` 用 `ON DELETE RESTRICT`：操作者用户不能被级联抹掉，保证可追责
 *   （设计 §5 DB CHANGE REQUEST B）。初始化提升（无既有 actor）时该列可为空。
 * - 索引覆盖三种查询路径：按时间倒序（默认列表）、按操作者、按目标对象。
 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    ...primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    action: adminAuditActionEnum('action').notNull(),
    targetType: adminAuditTargetTypeEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (table) => [
    // 默认列表按时间倒序（覆盖 `ORDER BY created_at DESC, id DESC` 的排序）。
    index('admin_audit_logs_created_at_desc_idx').on(table.createdAt),
    // 按操作者查询（用户详情页 / 审计筛选的 actor_id）。
    index('admin_audit_logs_actor_created_idx').on(table.actorUserId, table.createdAt),
    // 按目标对象查询（商品详情页关联日志）。
    index('admin_audit_logs_target_created_idx').on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
)
