import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { campusEmailVerifications } from '@fish/db/schema/verifications'
import { and, count, desc, eq, gte, isNull, ne } from 'drizzle-orm'
import type { VerificationCodeCodec } from './verification-provider'

/**
 * 校园邮箱验证码的持久化与限频（#68）。
 *
 * 限频维度（决策记录见 grilling 记录）：
 * - 每**邮箱** 24h ≤ 5 封、60s 间隔（防对同一收件箱轰炸）；
 * - 每**用户** 24h ≤ 10 封、60s 间隔（防换邮箱绕开）。
 * 全部落 `campus_email_verifications` 的 COUNT/MAX 查询，不引入 Redis。
 *
 * 一次性 / 尝试次数：验证走条件 UPDATE（`consumed_at IS NULL AND expires_at > now()
 * AND attempt_count < 5`），更新行数为 0 时按具体原因区分错误——不预先 SELECT 再写，
 * 避免并发双验证同时通过检查（TOCTOU）。
 */
export const CODE_TTL_MINUTES = 5
export const CODE_MAX_ATTEMPTS = 5
const SEND_INTERVAL_MS = 60_000
const EMAIL_DAILY_LIMIT = 5
const USER_DAILY_LIMIT = 10
const DAY_MS = 24 * 60 * 60 * 1000

/** 决策：发码阶段就拦截已被其他账号绑定的邮箱（省用户 5 分钟等待）；409。 */
export class VerificationError extends Error {
  constructor(
    readonly code:
      | 'EMAIL_ALREADY_BOUND'
      | 'RATE_LIMITED'
      | 'CODE_EXPIRED'
      | 'CODE_INVALID'
      | 'CODE_CONSUMED'
      | 'TOO_MANY_ATTEMPTS'
      | 'ALREADY_VERIFIED',
    readonly status: 409 | 410 | 422 | 429,
    message: string,
  ) {
    super(message)
    this.name = 'VerificationError'
  }
}

type VerificationExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export interface VerificationStore {
  /** 发码前的三项检查；全部通过才允许 INSERT。`retryAfterSeconds` 给限频响应用。 */
  checkSendAllowed(
    executor: VerificationExecutor,
    userId: string,
    email: string,
  ): Promise<{
    retryAfterSeconds?: number
  }>
  insertPending(
    executor: VerificationExecutor,
    input: { userId: string; email: string; codeHash: string; expiresAt: Date },
  ): Promise<void>
  /**
   * 原子消费：条件 UPDATE 命中（返回行）后按 `codeHash` 比对；不命中按最新行状态归类失败原因。
   * 失败会推进 `attempt_count`；达上限时同时置 `consumed_at`（作废）。
   */
  consumeLatest(
    executor: VerificationExecutor,
    userId: string,
    email: string,
    code: string,
    codes: VerificationCodeCodec,
  ): Promise<
    | { outcome: 'MATCH' }
    | {
        outcome: 'FAIL'
        reason: 'CODE_EXPIRED' | 'CODE_INVALID' | 'CODE_CONSUMED' | 'TOO_MANY_ATTEMPTS'
      }
  >
  /** 验证成功事务内调用：绑邮箱 + 升级状态。邮箱被他人占用时返回 false（409）。 */
  bindEmailAndVerify(
    executor: VerificationExecutor,
    userId: string,
    email: string,
  ): Promise<boolean>
  /** 状态页：当前用户是否已验证 + 脱敏邮箱（未绑定返回 null email）。 */
  loadStatus(
    executor: VerificationExecutor,
    userId: string,
  ): Promise<{
    authStatus: 'UNVERIFIED' | 'VERIFIED'
    verifiedAt: Date | null
    campusEmail: string | null
  }>
}

export function createVerificationStore(_db: Db): VerificationStore {
  async function latestAt(
    executor: VerificationExecutor,
    column: 'email' | 'userId',
    value: string,
  ): Promise<Date | null> {
    const rows =
      column === 'email'
        ? await executor
            .select({ sentAt: campusEmailVerifications.createdAt })
            .from(campusEmailVerifications)
            .where(eq(campusEmailVerifications.email, value))
            .orderBy(desc(campusEmailVerifications.createdAt))
            .limit(1)
        : await executor
            .select({ sentAt: campusEmailVerifications.createdAt })
            .from(campusEmailVerifications)
            .where(eq(campusEmailVerifications.userId, value))
            .orderBy(desc(campusEmailVerifications.createdAt))
            .limit(1)
    return rows[0]?.sentAt ?? null
  }

  async function countSince(
    executor: VerificationExecutor,
    column: 'email' | 'userId',
    value: string,
    since: Date,
  ): Promise<number> {
    const predicate =
      column === 'email'
        ? and(
            eq(campusEmailVerifications.email, value),
            gte(campusEmailVerifications.createdAt, since),
          )
        : and(
            eq(campusEmailVerifications.userId, value),
            gte(campusEmailVerifications.createdAt, since),
          )
    const rows = await executor
      .select({ count: count() })
      .from(campusEmailVerifications)
      .where(predicate)
    return rows[0]?.count ?? 0
  }

  return {
    async checkSendAllowed(executor, userId, email) {
      const now = Date.now()

      // 已绑定 → 不再发码（决策 Q7a：不支持改绑）。
      const self = await executor
        .select({ campusEmail: users.campusEmail })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      if (self[0]?.campusEmail) {
        throw new VerificationError('ALREADY_VERIFIED', 409, '已完成校园认证，无需重复验证')
      }

      // 目标邮箱被其他账号占用 → 409（决策 Q7c：发码阶段提前拦截）。
      const taken = await executor
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.campusEmail, email), ne(users.id, userId)))
        .limit(1)
      if (taken.length > 0) {
        throw new VerificationError('EMAIL_ALREADY_BOUND', 409, '该校园邮箱已绑定其他账号')
      }

      // 60s 间隔（邮箱与用户任一命中都算）。
      const [lastForEmail, lastForUser] = await Promise.all([
        latestAt(executor, 'email', email),
        latestAt(executor, 'userId', userId),
      ])
      const lastSentAt =
        lastForEmail && lastForUser
          ? lastForEmail.getTime() > lastForUser.getTime()
            ? lastForEmail
            : lastForUser
          : (lastForEmail ?? lastForUser)
      if (lastSentAt && now - lastSentAt.getTime() < SEND_INTERVAL_MS) {
        const retryAfterSeconds = Math.ceil(
          (SEND_INTERVAL_MS - (now - lastSentAt.getTime())) / 1000,
        )
        throw new VerificationError(
          'RATE_LIMITED',
          429,
          `发送太频繁，请 ${retryAfterSeconds} 秒后再试`,
        )
      }

      // 24h 总量（邮箱 ≤ 5 / 用户 ≤ 10）。
      const dayAgo = new Date(now - DAY_MS)
      const [emailCount, userCount] = await Promise.all([
        countSince(executor, 'email', email, dayAgo),
        countSince(executor, 'userId', userId, dayAgo),
      ])
      if (emailCount >= EMAIL_DAILY_LIMIT || userCount >= USER_DAILY_LIMIT) {
        throw new VerificationError('RATE_LIMITED', 429, '今日发送次数已达上限，请明天再试')
      }

      return {}
    },

    async insertPending(executor, input) {
      await executor.insert(campusEmailVerifications).values({
        userId: input.userId,
        email: input.email,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
      })
    },

    async consumeLatest(executor, userId, email, code, codes) {
      // 只看该用户 + 该邮箱的最新一行：用户拿旧码来验证时，按「无效」处理（重发即作废旧码）。
      const rows = await executor
        .select({
          id: campusEmailVerifications.id,
          codeHash: campusEmailVerifications.codeHash,
          expiresAt: campusEmailVerifications.expiresAt,
          consumedAt: campusEmailVerifications.consumedAt,
          attemptCount: campusEmailVerifications.attemptCount,
        })
        .from(campusEmailVerifications)
        .where(
          and(
            eq(campusEmailVerifications.userId, userId),
            eq(campusEmailVerifications.email, email),
          ),
        )
        .orderBy(desc(campusEmailVerifications.createdAt))
        .limit(1)

      const row = rows[0]
      if (!row) return { outcome: 'FAIL', reason: 'CODE_INVALID' }
      if (row.consumedAt) return { outcome: 'FAIL', reason: 'CODE_CONSUMED' }
      if (row.expiresAt.getTime() <= Date.now()) {
        // 过期即消费，旧码不能再被验证。
        await executor
          .update(campusEmailVerifications)
          .set({ consumedAt: new Date() })
          .where(eq(campusEmailVerifications.id, row.id))
        return { outcome: 'FAIL', reason: 'CODE_EXPIRED' }
      }

      // 条件 UPDATE：只还有尝试余额时推进计数；返回更新行数判断是否还有效。
      // 并发两次验证同时通过 SELECT 检查时，第二次的 UPDATE 会因 consumed_at IS NULL
      // 不再命中（第一次已置值），不会出现双成功。
      const updated = await executor
        .update(campusEmailVerifications)
        .set({
          attemptCount: row.attemptCount + 1,
          ...(row.attemptCount + 1 >= CODE_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}),
        })
        .where(
          and(eq(campusEmailVerifications.id, row.id), isNull(campusEmailVerifications.consumedAt)),
        )
        .returning({ id: campusEmailVerifications.id })
      if (updated.length === 0) return { outcome: 'FAIL', reason: 'CODE_CONSUMED' }
      if (row.attemptCount + 1 > CODE_MAX_ATTEMPTS) {
        return { outcome: 'FAIL', reason: 'TOO_MANY_ATTEMPTS' }
      }

      const matched = await codes.matches(code, row.codeHash)
      if (!matched) {
        // 达到上限的那一次失败已同时置 consumed_at。
        return {
          outcome: 'FAIL',
          reason: row.attemptCount + 1 >= CODE_MAX_ATTEMPTS ? 'TOO_MANY_ATTEMPTS' : 'CODE_INVALID',
        }
      }

      // 验证成功：先消费验证码（一次性语义在数据层成立），绑定放在 verify 的外层事务里。
      await executor
        .update(campusEmailVerifications)
        .set({ consumedAt: new Date() })
        .where(eq(campusEmailVerifications.id, row.id))
      return { outcome: 'MATCH' }
    },

    async bindEmailAndVerify(executor, userId, email) {
      // 唯一索引兜底并发；先查一次给友好 409（isUniqueViolation 见 service.ts）。
      const taken = await executor
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.campusEmail, email), ne(users.id, userId)))
        .limit(1)
      if (taken.length > 0) return false

      await executor
        .update(users)
        .set({ campusEmail: email, authStatus: 'VERIFIED', verifiedAt: new Date() })
        .where(eq(users.id, userId))
      return true
    },

    async loadStatus(executor, userId) {
      const rows = await executor
        .select({
          authStatus: users.authStatus,
          verifiedAt: users.verifiedAt,
          campusEmail: users.campusEmail,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      const row = rows[0]
      if (!row) throw new Error('loadStatus: user not found')
      return row
    },
  }
}
