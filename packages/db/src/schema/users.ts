import { pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'

/** 校园认证状态。#68 后 VERIFIED 只能由「教育邮箱验证码验证成功」事务写入。 */
export const authStatusEnum = pgEnum('auth_status', ['UNVERIFIED', 'VERIFIED'])

export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN'])

export const users = pgTable(
  'users',
  {
    ...primaryKey(),
    /** 学号即账号（#3：使用学号注册账号）。API 不返回该列。 */
    studentNo: text('student_no').notNull().unique(),
    /** #3 已落地：seed 写入真实 `Bun.password`（argon2id）哈希，见 `seed.ts`。 */
    passwordHash: text('password_hash').notNull(),
    nickname: text('nickname').notNull(),
    avatarUrl: text('avatar_url'),
    campus: text('campus'),
    authStatus: authStatusEnum('auth_status').notNull().default('UNVERIFIED'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    /**
     * 校园认证的唯一绑定（#68）。NULL = 从未完成过校园邮箱验证；非 NULL 只能由
     * 验证成功事务写入（见 auth 模块 verification-store.ts），注册不改它，
     * #68 后新注册一律 UNVERIFIED。唯一索引保证一个校园邮箱至多绑一个账号。
     */
    campusEmail: text('campus_email'),
    /** 管理授权依据（#73）；只由 `requireAdmin` 读取，普通用户 `Me` DTO 不暴露它。 */
    role: userRoleEnum('role').notNull().default('USER'),
    ...timestamps(),
  },
  (table) => [uniqueIndex('users_campus_email_uq').on(table.campusEmail)],
)
