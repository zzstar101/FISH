import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { users } from './users'

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * Web 扫码登录的一次性票据（#197）。
 *
 * 生命周期：Web 建票（`pending`）→ 小程序扫码确认后绑定 `bound_user_id`（`confirmed`）
 * → Web 凭 `verifier` 兑换，同事务内写 `consumed_at`（`consumed`）→ 到期由有界清理删除。
 *
 * **状态不落列**，全部由时间戳推导（与 `sessions` / `campus_email_verifications` 同一取舍，
 * 少一个 migration 面）：
 * - `consumed_at IS NOT NULL` → consumed
 * - `expires_at <= now()` → expired
 * - `bound_user_id IS NOT NULL` → confirmed
 * - 否则 pending
 *
 * 安全边界（#197 冻结）：
 * - `ticket` 印在二维码里，**是公开的**；真正拦住他人顶替的是浏览器独占的 `verifier`。
 *   两者都只存 SHA-256——库被读走也无法据此兑换会话。
 * - 明文只出现在「建票响应」与「查状态 / 兑换请求的请求头」，永不落库、永不进日志。
 * - 一张票最多绑一个用户：确认时的并发保护靠 `bound_user_id IS NULL` 这一条件，
 *   而不是先读后写。
 *
 * 过期回收：与 `sessions` 不同，这张表**建了 `expires_at` 索引**并做有界清理——
 * 票据的创建频率远高于登录（每次点开登录页都可能建一张），不清理会脏得很快。
 * 清理在写路径顺带做（`DELETE ... WHERE expires_at < now() LIMIT n`），不引新基础设施。
 */
export const loginTickets = pgTable(
  'login_tickets',
  {
    ...primaryKey(),
    /** sha256(ticket) 的 hex。ticket 是 22 字符 base64url，明文不落库。 */
    ticketHash: text('ticket_hash').notNull(),
    /** sha256(verifier) 的 hex。verifier 只在发起登录的那个浏览器里。 */
    verifierHash: text('verifier_hash').notNull(),
    /** NULL = 还没有任何用户确认过这张票；非 NULL = 已绑定，且**不允许被改绑**。 */
    boundUserId: uuid('bound_user_id').references(() => users.id, { onDelete: 'cascade' }),
    boundAt: timestamptz('bound_at'),
    /** NULL = 尚未兑换；非 NULL = 已被某个浏览器兑换过（重复兑换一律拒绝）。 */
    consumedAt: timestamptz('consumed_at'),
    /** 固定 5 分钟（#197 决策）。 */
    expiresAt: timestamptz('expires_at').notNull(),
    // 不可变行（除 bound_* / consumed_at 由确认与兑换更新）：只取 createdAt。
    createdAt: createdAt(),
  },
  (table) => [
    // 服务端只按哈希查票，明文永不入库——也没有任何按明文查的需求。
    uniqueIndex('login_tickets_ticket_hash_uq').on(table.ticketHash),
    // 有界清理按过期时间扫描（见文件头说明）。
    index('login_tickets_expires_at_idx').on(table.expiresAt),
    // 删除用户时的级联需要按 user_id 定位。
    index('login_tickets_bound_user_id_idx').on(table.boundUserId),
  ],
)
