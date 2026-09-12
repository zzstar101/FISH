import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'

/** 校园认证状态。#3 负责写入与展示，学生证真伪由 provider 决定。 */
export const authStatusEnum = pgEnum('auth_status', ['UNVERIFIED', 'VERIFIED'])

export const users = pgTable('users', {
  ...primaryKey(),
  /** 学号即账号（#3：使用学号注册账号）。API 不返回该列。 */
  studentNo: text('student_no').notNull().unique(),
  /** #3 定义哈希算法前，seed 使用占位值。 */
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname').notNull(),
  avatarUrl: text('avatar_url'),
  campus: text('campus'),
  authStatus: authStatusEnum('auth_status').notNull().default('UNVERIFIED'),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  ...timestamps(),
})
