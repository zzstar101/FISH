import type { LoginRequest, RegisterRequest } from '@fish/contracts/auth/session'
import { CampusSchema, type Me, MeSchema } from '@fish/contracts/auth/user'
import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { eq } from 'drizzle-orm'
import { AuthError } from './errors'
import { LOGIN_LOCK_SECONDS, type LoginAttemptStore } from './login-attempts'
import type { Sessions } from './session'

type UserRow = typeof users.$inferSelect

/**
 * DB 行 → 对外 DTO。`student_no` 与 `password_hash` 永不经过这里（#3：不公开完整学号）。
 *
 * `campus` / `avatarUrl` 在库里都是无约束 `text`，而契约声明它们是枚举 / `z.url()`；
 * 值域外的历史值一律降级为 `null`，否则前端按 `MeSchema` 解析 `/me` 会直接抛错、登录态全挂。
 */
function toMe(row: UserRow): Me {
  return {
    id: row.id,
    nickname: row.nickname,
    avatarUrl: MeSchema.shape.avatarUrl.safeParse(row.avatarUrl).data ?? null,
    campus: CampusSchema.safeParse(row.campus).data ?? null,
    authStatus: row.authStatus,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  }
}

function requireRow<T>(rows: T[]): T {
  const row = rows[0]
  if (!row) throw new Error('INSERT users 未返回行')
  return row
}

/**
 * PG 唯一约束冲突。两个坑：Bun 的 `PostgresError` 把 SQLSTATE 放在 `errno` 上（`code` 恒为
 * `'ERR_POSTGRES_SERVER_ERROR'`）；而 Drizzle 会把它包一层（`{ query, params, cause }`），
 * 所以要顺着 `cause` 链找。
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ('errno' in current && current.errno === '23505') return true
    current = current.cause
  }
  return false
}

/** 库里可能存在历史脏哈希（如 #2 seed 的占位值），校验失败一律当密码错误，不要 500。 */
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}

/** 分钟数从常量派生：写死"10 分钟"会让文案与阈值各自漂移。 */
function lockMessage(): string {
  return `错误次数过多，请 ${Math.round(LOGIN_LOCK_SECONDS / 60)} 分钟后再试`
}

export function createAuthService(deps: {
  db: Db
  sessions: Sessions
  attempts: LoginAttemptStore
}) {
  const { db, sessions, attempts } = deps

  return {
    async register(input: RegisterRequest): Promise<{ user: Me; token: string; expiresAt: Date }> {
      // 快速路径：正常并发下先给出 409，而不是等唯一约束报错
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.studentNo, input.studentNo))
        .limit(1)
      if (existing.length > 0) throw new AuthError('STUDENT_NO_TAKEN', 409, '该学号已注册')

      const passwordHash = await Bun.password.hash(input.password)

      let created: { row: UserRow; token: string; expiresAt: Date }
      try {
        // 写用户与写会话必须同一个事务：否则会话写入失败会留下一个
        // 「学号已占用但登不进去」的账号，重试注册只会得到 409。
        created = await db.transaction(async (tx) => {
          const row = requireRow(
            await tx
              .insert(users)
              .values({
                studentNo: input.studentNo,
                passwordHash,
                nickname: input.nickname,
                campus: input.campus,
                // #68：注册不再认证。VERIFIED 只能由校园邮箱验证码流程（verification-service.ts）
                // 产生，那里同时写入 campus_email + verifiedAt，保持 VERIFIED ⟺ 已绑定邮箱。
                authStatus: 'UNVERIFIED',
                verifiedAt: null,
              })
              .returning(),
          )
          return { row, ...(await sessions.createWith(tx, row.id)) }
        })
      } catch (error) {
        // 并发下两个请求可能同时通过上面的快速路径，靠唯一约束兜底
        if (isUniqueViolation(error)) {
          throw new AuthError('STUDENT_NO_TAKEN', 409, '该学号已注册')
        }
        throw error
      }

      return { user: toMe(created.row), token: created.token, expiresAt: created.expiresAt }
    },

    async login(input: LoginRequest): Promise<{ user: Me; token: string; expiresAt: Date }> {
      // #132：锁定期内一律拒绝，且**不跑口令校验**。argon2id 每次校验都有真实 CPU 代价
      // （seed 的哈希即 argon2id），先查锁让"被锁了还继续撞"连校验都省掉。
      const lockedBefore = await attempts.isLocked(input.studentNo)
      if (lockedBefore) throw new AuthError('LOGIN_LOCKED', 429, lockMessage())

      const rows = await db
        .select()
        .from(users)
        .where(eq(users.studentNo, input.studentNo))
        .limit(1)

      const row = rows[0]
      const passwordOk = row ? await verifyPassword(input.password, row.passwordHash) : false
      // 错误码不区分「学号不存在」与「密码错误」。注册口会显式返回 409，因此账号存在性本来就
      // 是可探测的 —— 所以这里刻意不补时序防护（#132 的"明确不做"有理由：只给登录做恒定
      // 耗时是假的安全）。限流由 attempts 承担；未注册的学号同样计数，探测才有代价。
      if (!row || !passwordOk) {
        const after = await attempts.recordFailure(input.studentNo)
        if (after.locked) throw new AuthError('LOGIN_LOCKED', 429, lockMessage())
        throw new AuthError('INVALID_CREDENTIALS', 401, '学号或密码不正确')
      }

      // 清零的是"口令校验失败次数"这个语义，因此校验通过即清，不等会话写入结果。
      await attempts.clear(input.studentNo)
      const { token, expiresAt } = await sessions.create(row.id)
      return { user: toMe(row), token, expiresAt }
    },

    async logout(token: string | undefined): Promise<void> {
      if (token) await sessions.revoke(token)
    },

    /** 认证守卫用：令牌 → 当前用户；无效或过期返回 null。 */
    async loadMe(token: string): Promise<Me | null> {
      const session = await sessions.resolve(token)
      if (!session) return null

      const rows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1)
      const row = rows[0]
      return row ? toMe(row) : null
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
