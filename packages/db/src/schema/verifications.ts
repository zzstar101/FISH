import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { users } from './users'

export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED'

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 校园邮箱验证码（#68）。
 *
 * 生命周期：发码 INSERT（delivery='PENDING'）→ transport 受理后置 'SENT'（失败置
 * 'FAILED'）→ 验证成功或作废写 `consumed_at` → 过期行自然失效。
 *
 * delivery 状态（#68 评审 P2-5）：只有 **'SENT'** 的行参与「最新码」判定与限频计数——
 * 发送失败（FAILED）既不使用户手中已有的旧码失效，也不消耗 60s/每日额度。
 * 消费/尝试计数不受 delivery 影响：SENT 之前的旧码依然可验证。
 * 明文码只出现在邮件内容里；库与日志只允许 argon2id 哈希（与 users.password_hash 同一纪律）。
 *
 * 限频查询都落在这张表上（#68 不引入 Redis）：
 * - 60s 间隔：`(email, sent_at)` / `(user_id, sent_at)` 的最近一封；
 * - 每邮箱 24h ≤ 5、每用户 24h ≤ 10：对 `sent_at` 范围 COUNT。
 * 两个索引分别服务这两类谓词；过期清理不做（行量 = 发码量，本期可接受，同 sessions 的取舍）。
 *
 * 尝试次数直接以 `attempt_count` 计数（成功/作废后不再增加），验证时原子 `UPDATE ... WHERE
 * attempt_count < 5 AND consumed_at IS NULL AND expires_at > now()`，成功即置 consumed_at，
 * 不需要独立状态列。
 */
export const campusEmailVerifications = pgTable(
  'campus_email_verifications',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    /** argon2id 哈希。明文码永不落库、永不进日志（#68 Done）。 */
    codeHash: text('code_hash').notNull(),
    /** 固定 5 分钟（#68 决策）。 */
    expiresAt: timestamptz('expires_at').notNull(),
    /** NULL = 仍可验证；非 NULL = 已被消费（成功或作废）。一次性语义由它承载。 */
    consumedAt: timestamptz('consumed_at'),
    /**
     * 邮件投递状态。PENDING = transport 尚未受理；SENT = 已受理；FAILED = 投递失败。
     * 只有 SENT 参与 latest/限频（评审 P2-5）；FAILED 行保留作审计，不计额度。
     */
    delivery: text('delivery').$type<DeliveryStatus>().notNull().default('PENDING'),
    /** 验证失败次数；达 5 次后该码作废。 */
    attemptCount: integer('attempt_count').notNull().default(0),
    // 不可变行（除 consumed_at / attempt_count 由验证事务更新）：只取 createdAt。
    createdAt: createdAt(),
  },
  (table) => [
    // 发码限频按「邮箱 + 时间」；login 用户换邮箱轰炸他人也按 email 维度被这条拦住。
    index('campus_email_verifications_email_sent_idx').on(table.email, table.createdAt),
    // 每用户 24h 总量限频。
    index('campus_email_verifications_user_id_sent_idx').on(table.userId, table.createdAt),
  ],
)
