import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { users } from './users'

/**
 * 出口值域跨 Owner 增长，用 text + TS 收窄，避免每加一类出口都要改 migration
 * （同 `jobs.type` 的口径，见 ./jobs.ts）。
 */
export type AiPolishOutcome =
  | 'OK'
  | 'EMPTY'
  | 'QUOTA'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'NOT_CONFIGURED'
  | 'TOKEN_LOST'

/**
 * #141 商品描述 AI 润色的配额与质量指标。
 *
 * 不存任何用户文本、脱敏映射与上游响应体（设计 §6.2）。`outcome` 可空：配额检查通过后先落
 * 占位行（"上游失败也扣配额"由这一步保证），调用结束后才回写出口；因此配额的两条检查必须用
 * `IS DISTINCT FROM 'EMPTY'` 而不是 `<> 'EMPTY'`——后者会把尚未回写的 NULL 行排除在计数外。
 */
export const aiPolishRequests = pgTable(
  'ai_polish_requests',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    outcome: text('outcome').$type<AiPolishOutcome>(),
    candidateCount: integer('candidate_count'),
    filteredCount: integer('filtered_count'),
    latencyMs: integer('latency_ms'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    inputChars: integer('input_chars'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
  },
  (table) => [index('ai_polish_requests_user_id_created_at_idx').on(table.userId, table.createdAt)],
)
