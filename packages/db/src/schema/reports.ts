import { sql } from 'drizzle-orm'
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { users } from './users'

/** 举报对象类型。#73 治理半场只支持商品与用户，留言 / 私聊消息不在本期范围。 */
export const reportTargetTypeEnum = pgEnum('report_target_type', ['LISTING', 'USER'])

/**
 * 举报原因。**一张枚举同时服务两类对象**，契约层按 targetType 收敛可选子集：
 * 商品 = MISLEADING / PROHIBITED / FRAUD / SPAM / OTHER，
 * 用户 = HARASSMENT / FRAUD / IMPERSONATION / ABUSE / OTHER。
 * 只在 DB 放一个枚举，避免为"原因随目标类型变化"再加 CHECK 约束。
 */
export const reportReasonEnum = pgEnum('report_reason', [
  'MISLEADING',
  'PROHIBITED',
  'FRAUD',
  'SPAM',
  'HARASSMENT',
  'IMPERSONATION',
  'ABUSE',
  'OTHER',
])

/** 举报状态机：PENDING → HANDLED（受理）/ REJECTED（驳回）。治理动作与状态正交，另走审计与限制表。 */
export const reportStatusEnum = pgEnum('report_status', ['PENDING', 'HANDLED', 'REJECTED'])

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 用户举报（#73 治理半场）。
 *
 * - `targetType` + `targetId` 是多态目标（不建外键）：口径与 `admin_audit_logs` 一致；
 *   目标存在性由 service 在创建时校验，删除不在本期范围内。
 * - `reporterId` 用默认 `NO ACTION`：举报人不可被静默抹掉，与 `wishes.user_id` 同口径。
 * - 部分唯一索引 `reports_pending_reporter_target_uidx`：同一举报人对同一目标**只允许一条未决举报**，
 *   并发重复提交靠数据库兜底（唯一冲突 → 返回已存在的那条），避免两个请求都查不到重复而双双插入。
 * - `status` / `handledBy` / `handledAt` / `handlingReason` 只在 Admin 处理时由同一次 UPDATE 写入。
 */
export const reports = pgTable(
  'reports',
  {
    ...primaryKey(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id),
    targetType: reportTargetTypeEnum('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reason: reportReasonEnum('reason').notNull(),
    /** 举报人补充说明，可空。 */
    detailText: text('detail_text'),
    status: reportStatusEnum('status').notNull().default('PENDING'),
    handledBy: uuid('handled_by').references(() => users.id),
    handledAt: timestamptz('handled_at'),
    handlingReason: text('handling_reason'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('reports_pending_reporter_target_uidx')
      .on(table.reporterId, table.targetType, table.targetId)
      .where(sql`${table.status} = 'PENDING'`),
    // Admin 队列：按状态捞列表 + 时间倒序（含"只看未决"）。
    index('reports_status_created_at_idx').on(table.status, table.createdAt),
    // 「我的举报」：按举报人 + 时间倒序。
    index('reports_reporter_created_at_idx').on(table.reporterId, table.createdAt),
    // 管理端按目标聚合（多个举报人打同一个目标）。
    index('reports_target_created_at_idx').on(table.targetType, table.targetId, table.createdAt),
  ],
)
