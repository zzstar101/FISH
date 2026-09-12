import type { LoginRequest, RegisterRequest } from '@fish/contracts/auth/session'
import { CampusSchema, type Me } from '@fish/contracts/auth/user'
import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { eq } from 'drizzle-orm'
import { AuthError } from './errors'
import type { CampusVerificationProvider } from './provider'
import type { Sessions } from './session'

type UserRow = typeof users.$inferSelect

/** DB 行 → 对外 DTO。`student_no` 与 `password_hash` 永不经过这里（#3：不公开完整学号）。 */
function toMe(row: UserRow): Me {
  return {
    id: row.id,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    // 值域外的历史数据按「未知校区」处理，而不是把非法值透给前端
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
function isUniqueViolation(error: unknown): boolean {
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

export function createAuthService(deps: {
  db: Db
  sessions: Sessions
  provider: CampusVerificationProvider
}) {
  const { db, sessions, provider } = deps

  return {
    async register(input: RegisterRequest): Promise<{ user: Me; token: string; expiresAt: Date }> {
      // 快速路径：正常并发下先给出 409，而不是等唯一约束报错
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.studentNo, input.studentNo))
        .limit(1)
      if (existing.length > 0) throw new AuthError('STUDENT_NO_TAKEN', 409, '该学号已注册')

      const verification = await provider.verify({ studentNo: input.studentNo })
      const passwordHash = await Bun.password.hash(input.password)

      let row: UserRow
      try {
        row = requireRow(
          await db
            .insert(users)
            .values({
              studentNo: input.studentNo,
              passwordHash,
              nickname: input.nickname,
              // 真实 Provider 可给出权威校区；Mock 不返回，用注册时用户填的
              campus: verification.campus ?? input.campus,
              authStatus: verification.status,
              verifiedAt: verification.status === 'VERIFIED' ? new Date() : null,
            })
            .returning(),
        )
      } catch (error) {
        // 并发下两个请求可能同时通过上面的快速路径，靠唯一约束兜底
        if (isUniqueViolation(error)) {
          throw new AuthError('STUDENT_NO_TAKEN', 409, '该学号已注册')
        }
        throw error
      }

      const { token, expiresAt } = await sessions.create(row.id)
      return { user: toMe(row), token, expiresAt }
    },

    async login(input: LoginRequest): Promise<{ user: Me; token: string; expiresAt: Date }> {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.studentNo, input.studentNo))
        .limit(1)

      const row = rows[0]
      const passwordOk = row ? await verifyPassword(input.password, row.passwordHash) : false
      // 学号不存在与密码错误共用同一个错误：不泄漏某个学号是否已注册
      if (!row || !passwordOk) {
        throw new AuthError('INVALID_CREDENTIALS', 401, '学号或密码不正确')
      }

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
