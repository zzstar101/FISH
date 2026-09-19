import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 口令登录的失败计数（#132）。一行 = 一个学号的**当前**爆破代价。
 *
 * 主键是归一化后的 12 位学号而不是 `users.id`，且**刻意不建外键**：未注册学号的探测同样要付
 * 计数代价（否则"试哪些学号存在"完全免费），而那串号码在库里可能根本没有对应行。
 * 学号的格式规则只有一处定义（`@fish/contracts/auth/session` 的 `StudentNoSchema`），
 * 这里不再加 `CHECK (principal ~ ...)` 复制一份，避免两处规则漂移。
 *
 * 计数口径沿用 #70 面交码（5 次 / 锁 10 分钟），但有一处刻意的差异：面交码是"累计不清零、
 * 重签发才清零"，因为凭证本来就会重发；账号不会重发，累计不清零会让一个长期手滑的正常用户
 * 在任何时点突然被锁。所以这里用 `last_failure_at` 划一个滚动窗口，窗口外的旧失败视为新一代。
 *
 * 生命周期：只在**失败**时建行，成功登录 / 注册即删行。但它**不是有界的**：主键是 12 位数字，
 * 未注册号段同样计数，攻击者可以按请求速率无限灌新行。当前阶段接受（校园量级、写入即需
 * 真实请求），配套的清理与"聚合 argon2 代价"属于平台治理，另见 #132 的低危清单 —— 不要
 * 把这里当成"不需要清理任务"的承诺。
 */
export const authLoginAttempts = pgTable('auth_login_attempts', {
  principal: text('principal').primaryKey(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  /** 非空且晚于当前时刻 = 锁定期内，口令一律拒绝（即使正确）。 */
  lockedUntil: timestamptz('locked_until'),
  lastFailureAt: timestamptz('last_failure_at').notNull(),
})

export type AuthLoginAttemptRow = typeof authLoginAttempts.$inferSelect
