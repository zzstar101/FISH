import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'

/**
 * #694 M3：私聊发送 / 媒体预签名 / 新建会话的服务端滑动窗口计数。
 *
 * 一次请求一行，窗口按 `(bucket, subject)` 求 `created_at > now() - window` 的行数：
 * 跨实例共享同一份配额，不依赖单进程内存，也不引入 Redis（#694 明确不引）。
 * 过期行由每次计数时的同一事务顺手删除，不依赖额外定时任务。
 */
export const rateLimitEvents = pgTable(
  'rate_limit_events',
  {
    ...primaryKey(),
    /** 限流维度，如 `chat:send:conversation`。 */
    bucket: text('bucket').notNull(),
    /** 主体，如会话 id / 用户 id / `buyer:listing`。 */
    subject: text('subject').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('rate_limit_events_lookup_idx').on(table.bucket, table.subject, table.createdAt),
    index('rate_limit_events_created_at_idx').on(table.createdAt),
  ],
)
