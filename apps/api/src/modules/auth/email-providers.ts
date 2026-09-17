import { mkdir, open } from 'node:fs/promises'
import { renderVerificationMail } from './mail-template'
import type { EmailVerificationProvider, VerificationMail } from './verification-provider'

/**
 * 生产邮件 transport：Resend HTTP API（#68 评审 P1-3）。
 *
 * 走 REST 而不是 SMTP：无需额外依赖（Bun 原生 fetch），Resend 免费额度足够校园规模，
 * 域名验证 + SPF/DKIM 由 Resend 控制台托管。文档：https://resend.com/docs/api-reference
 */
export type ResendTransportConfig = {
  apiKey: string
  /** 已在 Resend 验证的发件人，如 `FISH <noreply@fish.example.edu>`。 */
  from: string
}

export function createResendTransport(config: ResendTransportConfig) {
  return {
    async send(mail: VerificationMail): Promise<void> {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.from,
          to: [mail.to],
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        }),
      })

      // Resend 2xx = 已受理（进入其投递队列）。非 2xx 上抛 → 发码路由 500，
      // 由调用方决定重试；验证码记录在事务里已提交（见 delivery 状态说明）。
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Resend 发送失败 (${response.status})：${detail.slice(0, 200)}`)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// dev outbox transport（不变，从原 mock-provider 迁移到这里以复用）
// ---------------------------------------------------------------------------

const DEFAULT_OUTBOX = '.dev/mail-outbox.jsonl'

/**
 * 路径可用 `MAIL_OUTBOX_PATH` 覆盖（测试隔离 / 自定义位置）；相对路径以进程 cwd 为基准
 * （`bun run dev:api` 的 cwd 是 `apps/api`）。
 */
export function createDevOutboxTransport(
  outboxPath: string = process.env.MAIL_OUTBOX_PATH ?? DEFAULT_OUTBOX,
) {
  return {
    async send(mail: VerificationMail): Promise<void> {
      // node:fs 的 append 模式：不覆盖已有 outbox（Bun 1.4 的 Bun.write 无 append 选项）。
      // append 标志不创建缺失的父目录，先补上（createPath 由这里显式负责）。
      const dir = outboxPath.slice(0, Math.max(outboxPath.lastIndexOf('/'), 0))
      if (dir) await mkdir(dir, { recursive: true })
      const handle = await open(outboxPath, 'a')
      try {
        await handle.write(`${JSON.stringify({ at: new Date().toISOString(), ...mail })}\n`)
      } finally {
        await handle.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Provider 装配：按环境选择 transport；共享同一套码与模板。
// ---------------------------------------------------------------------------

/** 码：crypto 拒绝采样 6 位等概率；哈希：argon2id（与 users.password_hash 同一纪律）。 */
const codes = {
  async generate() {
    const max = 1_000_000
    const limit = Math.floor(2 ** 32 / max) * max
    let value = 0
    do {
      value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
    } while (value >= limit)
    return (value % max).toString().padStart(6, '0')
  },
  async hash(code: string) {
    return Bun.password.hash(code)
  },
  async matches(code: string, hash: string) {
    try {
      return await Bun.password.verify(code, hash)
    } catch {
      return false
    }
  },
}

/**
 * dev / test Provider：写本地 outbox。
 */
export function createDevEmailVerificationProvider(
  outboxPath?: string,
  brand?: { logoUrl?: string },
): EmailVerificationProvider {
  const transport = createDevOutboxTransport(outboxPath)
  return {
    codes,
    transport,
    render(to, code, expiresInMinutes) {
      return renderVerificationMail(to, code, expiresInMinutes, brand?.logoUrl)
    },
  }
}

/**
 * production Provider：Resend 真实投递。
 * 配置缺失时由装配层（app.ts）在启动时显式失败——不在构造器里静默回退 dev outbox。
 */
export function createResendEmailVerificationProvider(
  config: ResendTransportConfig,
  brand?: { logoUrl?: string },
): EmailVerificationProvider {
  const transport = createResendTransport(config)
  return {
    codes,
    transport,
    render(to, code, expiresInMinutes) {
      return renderVerificationMail(to, code, expiresInMinutes, brand?.logoUrl)
    },
  }
}
