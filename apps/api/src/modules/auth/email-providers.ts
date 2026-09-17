import { mkdir, open } from 'node:fs/promises'
import { renderVerificationMail } from './mail-template'
import type { EmailVerificationProvider, VerificationMail } from './verification-provider'

/**
 * 生产邮件 transport：Resend HTTP API（#68 评审 P1-3）。
 *
 * 走 REST 而不是 SMTP：无需额外依赖（Bun 原生 fetch），Resend 免费额度足够校园规模，
 * 域名验证 + SPF/DKIM 由 Resend 控制台托管。文档：https://resend.com/docs/api-reference
 */
/**
 * Resend 的 POST /emails 支持 `Idempotency-Key`：网络超时/5xx 重试时同 key 不会重复
 * 发信（评审二轮 P2-4）。调用方必须传**稳定的逻辑发送 ID**（验证码行 id）。
 */
export type ResendTransportConfig = {
  apiKey: string
  /** 已在 Resend 验证的发件人，如 `鱼小应 <noreply@fish.edu.cn>`。 */
  from: string
  /** 请求超时毫秒数；Resend 无响应时快速失败，不拖住发码请求。默认 10s。 */
  timeoutMs?: number
}

/** Resend 错误响应体：`{ statusCode, name, message }`。 */
type ResendError = { statusCode?: number; name?: string; message?: string }

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export function createResendTransport(config: ResendTransportConfig) {
  const timeoutMs = config.timeoutMs ?? 10_000

  async function postOnce(mail: VerificationMail, idempotencyKey: string): Promise<Response> {
    // 超时控制：Resend 不可达时快速失败（delivery 置 FAILED），不拖住 API 请求。
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        // 同一次发送逻辑（含重试）固定同一 key：超时重试不会重复投递。
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: config.from,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response
  }

  return {
    async send(mail: VerificationMail): Promise<void> {
      // Idempotency-Key：mail.id 由调用方填（验证码行 id），重试期间保持不变。
      const idempotencyKey = `campus-verification/${mail.id ?? 'unknown'}`

      // 单次退避重试：429（Resend 侧限速，尊重 Retry-After）或 5xx（其服务故障）；
      // 401/403/422（配置或参数错）重试无意义，直接失败。
      let response: Response
      try {
        response = await postOnce(mail, idempotencyKey)
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('Retry-After'))
          await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000)
          response = await postOnce(mail, idempotencyKey)
        }
      } catch {
        // 网络错误/超时可能服务端已受理：仍上抛置 FAILED（额度已由 PENDING 预留，
        // 用户重试是新的一行），但错误信息不回显 provider 原文（评审二轮 P2-5）。
        throw new Error('Resend 请求失败（网络/超时）')
      }

      // Resend 2xx = 已受理。非 2xx 上抛 → 发码路由 500，该行 delivery 置 FAILED。
      // **响应体只读一次**，再尝试 JSON.parse（评审二轮 P3）。
      if (!response.ok) {
        const raw = await response.text().catch(() => '')
        let body: ResendError | null = null
        try {
          body = JSON.parse(raw) as ResendError
        } catch {
          // 非 JSON 错误体：不用原文（可能回显敏感字段），只保留 name/status。
        }
        // P2-5：provider 的 message 按不可信输入处理，不进日志（describeError 会打
        // Error.message 首行），只暴露状态码与错误类型。
        throw new Error(`Resend 发送失败 (${response.status} ${body?.name ?? 'unknown_error'})`)
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
