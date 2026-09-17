import type { VerificationMail } from './verification-provider'

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
