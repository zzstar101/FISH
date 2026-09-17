/**
 * 校园认证（#68）——验证码与邮件的 Provider 边界。
 *
 * 与 #3 的 `CampusVerificationProvider`（注册时同步判学号）不同，这里的 Provider 只负责
 * 「怎么生成 / 怎么送达 / 怎么比对」，**状态与绑定的写入不在 Provider 内**：那部分属于
 * 认证域的 service / store，换 Provider（如真 SMTP 或 CAS）不动主流程。
 */

/** 一封待发送的验证码邮件。`code` 只经过这里，实现方负责「送到」而不是「落日志」。 */
export type VerificationMail = {
  to: string
  subject: string
  html: string
  text: string
}

/** 邮件传输边界。dev 实现写本地 outbox；真 SMTP 实现后补，接口不变。 */
export interface MailTransport {
  send(mail: VerificationMail): Promise<void>
}

/** 验证码的生成与比对。独立于 transport：换码策略（如数字→字母）不动邮件部分。 */
export interface VerificationCodeCodec {
  generate(): Promise<string>
  /** 比对明文码与存储哈希。哈希算法由实现决定（本项目固定 argon2id）。 */
  matches(code: string, hash: string): Promise<boolean>
  hash(code: string): Promise<string>
}

/**
 * 验证码 Provider = 生成/比对 + 送达。验证域 service 只依赖这个接口。
 * 实现见 `email-providers.ts`（dev outbox / Resend）；`apps/api` 装配层注入。
 */
export interface EmailVerificationProvider {
  codes: VerificationCodeCodec
  transport: MailTransport
  /** 渲染一封验证码邮件（模板集中在这里，service 不拼 HTML）。 */
  render(to: string, code: string, expiresInMinutes: number): VerificationMail
}

/** 模板可用的品牌资产。`logoUrl` 必须是绝对地址（见 mail-template 的说明）。 */
export type VerificationBrand = {
  logoUrl?: string
}
