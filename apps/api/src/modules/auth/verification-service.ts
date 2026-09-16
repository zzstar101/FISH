import type { SendCodeRequest, VerifyCodeRequest } from '@fish/contracts/auth/verification'
import {
  maskCampusEmail,
  type VerificationStatus,
  VerificationStatusSchema,
} from '@fish/contracts/auth/verification'
import type { Db } from '@fish/db/client'
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
    /** 发码：限频检查 → 生成 → 哈希落库 → 交给 transport 送达。同步执行（决策：不进 jobs）。 */
    async sendCode(userId: string, input: SendCodeRequest): Promise<void> {
      const code = await provider.codes.generate()
      const codeHash = await provider.codes.hash(code)
      const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000)

      // 限频检查与落库同一个事务：并发两次发码不再可能同时通过 60s 检查（对抗审查 P2）。
      // 极端竞态仍可能由 PG 默认 READ COMMITTED 漏过，但每日总量限频按行计数兜底，
      // 发信量有上限；transport 在事务提交后执行，回滚不会留下已发出的邮件。
      await deps.db.transaction(async (tx) => {
        await store.checkSendAllowed(tx, userId, input.email)
        await store.insertPending(tx, { userId, email: input.email, codeHash, expiresAt })
      })

      // transport 失败不让验证码白白发出去：向上抛 500（onError 兜底）。
      // 明文码只在这里进过内存，不打日志。
      await provider.transport.send(provider.render(input.email, code, CODE_TTL_MINUTES))
    },

    /**
     * 验证：消费验证码（**事务外**，失败要留下尝试计数）→ 成功后绑邮箱 + 升级状态（事务内）。
     * 码已消费但绑定冲突（并发）时，码不退还（决策 Q7b）——重新发码即可。
     */
    async verify(userId: string, input: VerifyCodeRequest): Promise<VerificationStatus> {
      const result = await store.consumeLatest(
        deps.db,
        userId,
        input.email,
        input.code,
        provider.codes,
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
