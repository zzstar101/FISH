/**
 * Mock / dev 实现（#68）。
 *
 * - 码：`crypto` 随机 6 位数字（拒绝采样保证等概率，不用 `Math.random`）。
 * - 哈希：argon2id（`Bun.password`，与 users.password_hash 同一纪律）。
 * - 送达：dev transport 写 `.dev/mail-outbox.jsonl`（gitignore）——**不写进程日志**，
 *   Done 的「敏感认证信息不进入日志」由这条路径保证；真实 SMTP 后补时只换 transport。
 */
import { mkdir, open } from 'node:fs/promises'
import type {
  EmailVerificationProvider,
  VerificationBrand,
  VerificationMail,
} from './verification-provider'

const DEFAULT_OUTBOX = '.dev/mail-outbox.jsonl'

/**
 * 路径可用 `MAIL_OUTBOX_PATH` 覆盖（测试隔离 / 自定义位置）；相对路径以进程 cwd 为基准
 * （`bun run dev:api` 的 cwd 是 `apps/api`）。
 */
export function createDevEmailVerificationProvider(
  outboxPath: string = process.env.MAIL_OUTBOX_PATH ?? DEFAULT_OUTBOX,
  brand: VerificationBrand = {},
): EmailVerificationProvider {
  return {
    codes: {
      async generate() {
        // 6 位等概率：先拒绝采样到 [0, 2^32 向下取整到 1e6 倍数)，再取模到 [0, 1e6)。
        const max = 1_000_000
        const limit = Math.floor(2 ** 32 / max) * max
        let value = 0
        do {
          value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
        } while (value >= limit)
        return (value % max).toString().padStart(6, '0')
      },
      async hash(code) {
        return Bun.password.hash(code)
      },
      async matches(code, hash) {
        try {
          return await Bun.password.verify(code, hash)
        } catch {
          return false
        }
      },
    },

    transport: {
      async send(mail: VerificationMail) {
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
    },

    render(to, code, expiresInMinutes): VerificationMail {
      return renderVerificationMail(to, code, expiresInMinutes, brand.logoUrl)
    },
  }
}

/**
 * 验证码邮件模板（#68 工作项「出一版邮件模板」）：HTML + 纯文本 fallback。
 * 文案不落学号、不落姓名——邮件本身可能被转发，只给码与有效期。
 *
 * `logoUrl` 必须是**绝对地址**（邮件客户端不加载相对路径，base64 data URI 会被
 * Gmail 等剥离），由装配层用 `WEB_ORIGIN` 拼出；拿不到时退化为文字品牌名。
 */
export function renderVerificationMail(
  to: string,
  code: string,
  expiresInMinutes: number,
  logoUrl?: string,
): VerificationMail {
  const subject = `鱼小应校园认证验证码：${code}`
  const text = [
    `你的校园认证验证码是：${code}`,
    `${expiresInMinutes} 分钟内有效。本人操作请忽略这封邮件。`,
    '',
    '鱼小应 · 广应科校内二手交易平台',
  ].join('\n')
  const brand = logoUrl
    ? `<img alt="鱼小应 YUXIAOYING" height="36" src="${logoUrl}" style="display:block;height:36px;width:auto;" width="162"/>`
    : `<span style="font-size:20px;font-weight:700;color:#1c7df2;">🐟 鱼小应</span>`
  const html = `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:0;background:#f5f6f8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#ffffff;border-radius:16px;padding:32px 28px;font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;">
          <tr><td style="padding-bottom:20px;">
            ${brand}
          </td></tr>
          <tr><td style="font-size:16px;color:#1a1d21;padding-bottom:12px;">
            你的校园认证验证码
          </td></tr>
          <tr><td style="padding-bottom:20px;">
            <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1c7df2;background:#f0f6ff;border-radius:12px;padding:16px 0;text-align:center;">${code}</div>
          </td></tr>
          <tr><td style="font-size:14px;color:#5b6470;line-height:1.6;">
            验证码 <strong>${expiresInMinutes} 分钟</strong>内有效，输入即失效，请勿泄露给他人。<br/>
            如果这不是你的操作，请忽略这封邮件。
          </td></tr>
        </table>
        <p style="font-size:12px;color:#9aa3ad;margin:16px 0 0;">Copyright © 鱼小应 2026 All Rights Reserved.</p>
      </td></tr>
    </table>
  </body>
</html>`
  return { to, subject, html, text }
}
