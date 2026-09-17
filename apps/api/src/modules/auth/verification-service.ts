import type { SendCodeRequest, VerifyCodeRequest } from '@fish/contracts/auth/verification'
import {
  maskCampusEmail,
  type VerificationStatus,
  VerificationStatusSchema,
} from '@fish/contracts/auth/verification'
import type { Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { isUniqueViolation } from './service'
import type { EmailVerificationProvider } from './verification-provider'
import {
  CODE_TTL_MINUTES,
  createVerificationStore,
  VerificationError,
  type VerificationStore,
} from './verification-store'

/**
 * 校园认证验证码流程（#68）。
 *
 * 职责边界：Provider 只负责「生成 + 送达 + 比对」；状态与绑定写在 store（最终由
 * verify 的事务落到 users 表）。域名白名单在契约层已校验（`CampusEmailSchema`），
 * 这里不再重复判断。
 */
export function createVerificationService(deps: {
  db: Db
  provider: EmailVerificationProvider
  store?: VerificationStore
}) {
  const store = deps.store ?? createVerificationStore(deps.db)
  const { provider } = deps

  return {
    /**
     * 发码：限频检查（advisory lock 串行化）→ 落 PENDING → transport 送达 → 置 SENT/FAILED。
     *
     * delivery 状态语义（评审 P2-5）：transport 失败时该行置 FAILED——不作废旧码、
     * 不占额度；错误上抛为 500 让用户稍后重试。昂贵的 Argon2 哈希只在通过限频检查后
     * 计算（评审建议），必然 429 的请求不浪费 CPU。
     */
    async sendCode(userId: string, input: SendCodeRequest): Promise<void> {
      // 限频检查与落库同一个事务，且以 advisory lock 串行化（评审 P1）：
      // READ COMMITTED 下并发事务都会读到旧的 latest/count，仅靠事务无法拦住
      // 并发突破 60s / 24h 额度。按 (userId, email) 固定顺序取两把事务级 advisory
      // 锁，同一用户/同一邮箱的发码完全串行；不同用户不同邮箱互不阻塞。
      const { rowId, code } = await deps.db.transaction(async (tx) => {
        // 固定顺序（先 user 后 email）取锁，避免交叉等待死锁。
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`u:${userId}`}))`)
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`e:${input.email}`}))`)
        await store.checkSendAllowed(tx, userId, input.email)

        // 通过限频检查后才做昂贵的 Argon2 哈希（评审建议）：必然 429 的请求不浪费 CPU。
        const code = await provider.codes.generate()
        const codeHash = await provider.codes.hash(code)
        const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000)

        const { id } = await store.insertPending(tx, {
          userId,
          email: input.email,
          codeHash,
          expiresAt,
        })
        return { rowId: id, code }
      })

      // transport 在事务提交后执行（决策：同步发送，不进 jobs）。失败只影响这一行的
      // delivery 状态：置 FAILED（不作废旧码、不占额度），错误上抛 500 让用户重试。
      try {
        await provider.transport.send(provider.render(input.email, code, CODE_TTL_MINUTES))
        await store.markSent(rowId)
      } catch (error) {
        await store.markFailed(rowId)
        throw error
      }
    },

    /**
     * 验证：消费验证码（**事务外**，失败要留下尝试计数）→ 成功后绑邮箱 + 升级状态（事务内）。
     * 码已消费但绑定冲突（并发）时，码不退还（决策 Q7b）——重新发码即可。
     */
    async verify(userId: string, input: VerifyCodeRequest): Promise<VerificationStatus> {
      // consumeLatest 使用 SELECT ... FOR UPDATE，必须在事务内执行（评审 P1）。
      // 失败路径抛 VerificationError 会回滚事务——但消费/计数写也在事务内，同样回滚。
      // 为让失败仍留下尝试计数，把「消费 + 状态推进」与「绑定」拆开：
      // consume 在**独立事务**里完成并提交（FOR UPDATE 锁保证原子），绑定在成功后另起事务。
      const result = await deps.db.transaction(async (tx) =>
        store.consumeLatest(tx, userId, input.email, input.code, provider.codes),
      )
      if (result.outcome === 'FAIL') {
        const messages = {
          CODE_EXPIRED: '验证码已过期，请重新获取',
          CODE_INVALID: '验证码不正确',
          CODE_CONSUMED: '验证码已被使用，请重新获取',
          TOO_MANY_ATTEMPTS: '尝试次数过多，请重新获取验证码',
        } as const
        const statusMap = {
          CODE_EXPIRED: 410,
          CODE_INVALID: 422,
          CODE_CONSUMED: 409,
          TOO_MANY_ATTEMPTS: 429,
        } as const
        throw new VerificationError(
          result.reason,
          statusMap[result.reason],
          messages[result.reason],
        )
      }

      return deps.db
        .transaction(async (tx) => {
          const bound = await store.bindEmailAndVerify(tx, userId, input.email)
          if (!bound) {
            throw new VerificationError('EMAIL_ALREADY_BOUND', 409, '该校园邮箱已绑定其他账号')
          }

          const status = await store.loadStatus(tx, userId)
          return VerificationStatusSchema.parse({
            authStatus: status.authStatus,
            verifiedAt: status.verifiedAt?.toISOString() ?? null,
            maskedEmail: status.campusEmail ? maskCampusEmail(status.campusEmail) : null,
          })
        })
        .catch((error) => {
          // 并发下两个账号同时通过预检查、撞唯一索引 users_campus_email_uq：
          // 契约定为 409（同 Q7b 预检查语义），不能落成 500。码已消费不退还。
          if (isUniqueViolation(error)) {
            throw new VerificationError('EMAIL_ALREADY_BOUND', 409, '该校园邮箱已绑定其他账号')
          }
          throw error
        })
    },

    async status(userId: string): Promise<VerificationStatus> {
      const status = await store.loadStatus(deps.db, userId)
      return VerificationStatusSchema.parse({
        authStatus: status.authStatus,
        verifiedAt: status.verifiedAt?.toISOString() ?? null,
        maskedEmail: status.campusEmail ? maskCampusEmail(status.campusEmail) : null,
      })
    },
  }
}

export type VerificationService = ReturnType<typeof createVerificationService>
