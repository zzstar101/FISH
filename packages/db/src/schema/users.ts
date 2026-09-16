import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'

/** 校园认证状态。#3 负责写入与展示，学生证真伪由 provider 决定。 */
export const authStatusEnum = pgEnum('auth_status', ['UNVERIFIED', 'VERIFIED'])

/** 用户角色（#73 管理后台）。默认 `USER`，`ADMIN` 只允许受控初始化流程提升（设计 §3.3）。 */
export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN'])

export const users = pgTable('users', {
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
  /** 管理授权依据；只由 `requireAdmin`（#73）读取，普通用户 `Me` DTO 不暴露它。 */
  role: userRoleEnum('role').notNull().default('USER'),
  ...timestamps(),
})
