import type { VerificationStatus } from '@fish/contracts/auth/verification'

/**
 * 校园认证页的纯逻辑：阶段推导、重发倒计时、输入完整性。
 *
 * 抽出来是因为 web-pc 没有 jsdom：交互只能靠纯函数测，组件只做 `renderToStaticMarkup`
 * 静态渲染（见 `./verify-panel-view.test.tsx`）。
 */

/** 与服务端 60s 发送间隔对齐（`verification-store.ts` 的 `SEND_INTERVAL_MS`）。 */
export const RESEND_COOLDOWN_MS = 60_000

/**
 * 页面阶段。
 * - `loading`：`GET /auth/verification/status` 未回来，先不渲染表单（避免已认证用户看到输入框）。
 * - `unverified`：可填邮箱发码。
 * - `codeSent`：本次会话已成功发码，等用户填 6 位码。
 * - `verified`：服务端权威状态为已认证。
 * - `error`：状态查询失败（网络 / 500 / 契约漂移）。不能停在 loading 装作还在读，
 *   否则页面永远转圈，用户连重试按钮都拿不到。
 */
export type VerifyStage = 'loading' | 'unverified' | 'codeSent' | 'verified' | 'error'

/**
 * 阶段推导。**已认证优先于本地发码状态**：服务端说 VERIFIED 就不该再显示输入框。
 * `status === undefined` 表示状态查询尚未返回（或出错），此时保持 loading。
 */
export function stageFromStatus(
  status: VerificationStatus | undefined,
  codeSent: boolean,
): VerifyStage {
  if (status === undefined) return 'loading'
  if (status.authStatus === 'VERIFIED') return 'verified'
  return codeSent ? 'codeSent' : 'unverified'
}

/**
 * 距可重发还剩几秒（向上取整，0 表示可发）。
 *
 * 这是**纯展示**的节流：真正的限频裁决在服务端（同一邮箱/用户的 60s 与 24h 配额），
 * 端上倒计时只是避免用户点出一个注定 429 的请求，绝不代替服务端规则。
 */
export function resendSecondsLeft(nowMs: number, resendAtMs: number | null): number {
  if (resendAtMs === null) return 0
  return Math.max(0, Math.ceil((resendAtMs - nowMs) / 1000))
}

/** 6 位数字，与契约 `VerificationCodeSchema` 同口径（端上只做「够不够长」的即时反馈）。 */
export function isCodeComplete(code: string): boolean {
  return /^\d{6}$/.test(code)
}

/**
 * 现在能否点「获取验证码 / 重新发送」。
 *
 * `pending` 挡住重复点击（双击不会发两次请求），`secondsLeft > 0` 挡住倒计时内的重发。
 * 两者都只是端上节流，不放宽也不替代服务端限频。
 */
export function canRequestCode(input: { pending: boolean; secondsLeft: number }): boolean {
  return !input.pending && input.secondsLeft <= 0
}

/**
 * ISO 时间 → `YYYY-MM-DD`，非法/缺失落成 `—`。
 *
 * 用字符串切片而不是 `toLocaleDateString`：渲染测试与 SSR 不该依赖运行环境的 locale 与时区。
 */
export function formatVerifiedDate(verifiedAt: string | null): string {
  if (verifiedAt === null) return '—'
  const date = verifiedAt.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '—'
}
