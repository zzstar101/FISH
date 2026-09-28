import { sql } from 'drizzle-orm'
import { check, index, pgTable, uuid, varchar } from 'drizzle-orm/pg-core'
import { primaryKey, timestamptz } from './common'
import { users } from './users'

/**
 * 推荐请求上下文（#323 §M0）。
 *
 * 每次个性化 Feed 请求落一行，`id` 就是响应里的 `recommendationRequestId`：客户端把它带在
 * 曝光 / 详情事件上，服务端据此校验"这条事件确实来自那次推荐"。
 *
 * 为什么落表而不是签一个自包含 token：
 * - 归属校验需要**服务端真值**。token 里的身份是客户端声明 + 服务端签名，而这里存的是当时解析出的
 *   `user_id` / `anonymous_session_id`，切号后旧请求一眼能看出不属于当前身份；
 * - #323 §M8 的指标（feed empty rate、重复率、单 seller 曝光占比）都要按"一次请求"聚合，
 *   请求级上下文迟早要有地方落；
 * - 翻页复用同一个 requestId（同一 session 连续滚动 = 同一次推荐请求），一行对应整段滚动。
 *
 * `strategy_version` 必须落库：线上指标出问题时，"这批结果出自哪版策略"是第一个要回答的问题。
 *
 * 保留期：请求上下文 90 天（R6 落删除任务；R1 只建表 + 索引 + 文档）。
 * 事件行**刻意不建到本表的外键**：两者保留期不同，事件要比请求上下文活得久（180 天），
 * 有外键就得先删事件才能删上下文。
 */
export const recommendationRequests = pgTable(
  'recommendation_requests',
  {
    ...primaryKey(),
    /** 登录用户；注销后置空（事件/请求是运营数据，不随账号消失）。 */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 匿名会话标识（客户端生成、TTL 180 天）。 */
    anonymousSessionId: uuid('anonymous_session_id'),
    strategyVersion: varchar('strategy_version', { length: 64 }).notNull(),
    requestedAt: timestamptz('requested_at').notNull().defaultNow(),
  },
  (table) => [
    // 本表没有 `created_at`：不可变上下文行，`requested_at` 就是它的创建时刻。
    index('recommendation_requests_user_id_requested_at_idx').on(table.userId, table.requestedAt),
    index('recommendation_requests_session_id_requested_at_idx').on(
      table.anonymousSessionId,
      table.requestedAt,
    ),
    // 归属校验要求"每次请求都有身份"：客户端没带 session id 时服务端会补发一个，
    // 所以这里两列全空只可能是代码漏写 —— 在写入侧就不可表达，而不是留给事后排查。
    check(
      'recommendation_requests_has_identity',
      sql`${table.userId} IS NOT NULL OR ${table.anonymousSessionId} IS NOT NULL`,
    ),
  ],
)
