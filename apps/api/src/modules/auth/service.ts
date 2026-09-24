import type { LoginRequest, RegisterRequest } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { eq } from 'drizzle-orm'
import { AuthError } from './errors'
import { toMe, type UserRow } from './me'
import type { Sessions } from './session'
import { isUniqueViolation } from './unique'

function requireRow<T>(rows: T[]): T {
  const row = rows[0]
  if (!row) throw new Error('INSERT users 未返回行')
  return row
}

/** 库里可能存在历史脏哈希（如 #2 seed 的占位值），校验失败一律当密码错误，不要 500。 */
async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}

export function createAuthService(deps: { db: Db; sessions: Sessions }) {
  const { db, sessions } = deps

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
                // #68：注册不再认证。VERIFIED 只能由校园邮箱验证码流程（verification-service.ts）
                // 产生，那里同时写入 campus_email + verifiedAt，保持 VERIFIED ⟺ 已绑定邮箱。
                // #86 F：不再采集校区。
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
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.studentNo, input.studentNo))
        .limit(1)

      const row = rows[0]
      // #86 后微信注册的用户 student_no / password_hash 都是 NULL，查不到也登不了；
      // 防御性收窄让 NULL 哈希不进 argon2 比对（verify 对非字符串会抛错变 500）。
      const passwordOk =
        row?.passwordHash != null ? await verifyPassword(input.password, row.passwordHash) : false
      // 错误码不区分「学号不存在」与「密码错误」。注意注册口会显式返回 409，因此
      // 账号存在性本来就是可探测的；这里不做时序防护，也不做限流（记录为后续 issue）。
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

    /**
     * 绑定手机号（#86 C 节）：phone code（stub 下即明文手机号）→ 写 `users.phone`。
     * 只追加绑定，不动 session；唯一索引兜底并发，冲突报 409。
     * 冻结的语义：同一用户重复提交同一号码 = 幂等成功（UPDATE 命中自身行，不撞唯一索引）。
     * 已知缺口（不在本期）：解绑 / 换绑没有入口——`users.phone` 一旦写入无法清除，
     * 真实 getPhoneNumber 接入前需单开 Issue 冻结换绑规则。
     */
    async bindPhone(userId: string, phone: string): Promise<void> {
      try {
        await db.update(users).set({ phone }).where(eq(users.id, userId))
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthError('PHONE_ALREADY_BOUND', 409, '该手机号已绑定其他账号')
        }
        throw error
      }
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
