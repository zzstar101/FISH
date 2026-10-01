import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from './common'

/**
 * 拍照识图搜索的滚动窗口限流（#324 M2）。
 *
 * 与 `listing_lookup_attempts` 同一形态：匿名身份用 **HMAC 后的 subject key**，从不落原始 IP。
 * 一行的生命周期只有窗口长度，因此这张表既是限流依据也是清理对象。
 *
 * `subject_type` 区分 `ip` / `session` / `user`：登录用户按 `user` 计数，
 * 匿名同时按 `ip` 与 `session` 计数（两条都要过），这样"换会话刷"和"同 IP 换会话刷"
 * 都能被挡住，而共用出口 IP 的正常用户不会被单独一条限死。
 */
export const visualSearchAttempts = pgTable(
  'visual_search_attempts',
  {
    ...primaryKey(),
    subjectType: text('subject_type').notNull(),
    subjectKey: text('subject_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('visual_search_attempts_subject_time_idx').on(
      table.subjectType,
      table.subjectKey,
      table.createdAt,
    ),
    index('visual_search_attempts_created_at_idx').on(table.createdAt),
    check(
      'visual_search_attempts_subject_type_allowed',
      sql`${table.subjectType} in ('user', 'ip', 'session')`,
    ),
  ],
)
