/**
 * 扫码登录确认页的**纯逻辑**：启动参数解析 + 确认失败的分类。
 *
 * 页面有两个入口（#197）：
 * - **真实入口**：电脑端出小程序码，微信扫码直接拉起本页，票号在 `scene` 里。
 *   注意 scene 里**就是公开票据本身，没有 `t=` 之类的包装** —— #197 的
 *   `apps/api/src/modules/auth/router.ts` 调
 *   `codes.unlimited({ scene: ticket, page: SCAN_CONFIRM_PAGE, ... })`，`ticket` 是
 *   16 随机字节的 base64url（22 字符，`ScanTicketSchema`）。本文件按**同一形状**校验，
 *   否则真实出码进来会被判成「无效登录码」，连确认请求都发不出去。
 * - **演示 / 页内跳转入口**：显式 `ticket` 参数。它与 scene 走**同一套合法性校验** ——
 *   任意非空文本都不算票据，不然「无效登录码」态永远走不到。
 *
 * 形状规则的唯一来源是 `packages/contracts/src/auth/scan.ts`（`ScanTicketSchema`）。
 *
 * 两个入口都取不到合法票号时返回 null，页面落「无效登录码」态。
 */
import { ScanTicketSchema } from '@fish/contracts/auth/scan'

export type LoginLaunch = { ticket: string }

/**
 * 演示构建（`TARO_APP_MOCK=1`）在**没有电脑端真的出码**时的兜底票号。
 *
 * `'demoLoginConfirm'` 的 16 字节 base64url（`ZGVtb0xvZ2luQ29uZmlybQ`）：与真实票据
 * **同形同长**（22 字符，末字符落在 16 字节 base64url 的合法集合 `A/Q/g/w` 里），
 * 所以演示票过的是与真实票据完全同一道门禁，不需要为它开口子。
 */
export const DEMO_LOGIN_TICKET = 'ZGVtb0xvZ2luQ29uZmlybQ'

/**
 * 形状校验：直接用 #197 已合入的 `ScanTicketSchema`（`^[A-Za-z0-9_-]{22}$`），
 * 不留第二套规则。
 *
 * **不 trim**：`ScanTicketSchema` 是 `z.string().regex(...)`，没有任何 trim/transform ——
 * `"  <票据>  "` 这类字符串后端永远不会签发。这里多一层 trim 就等于把「合法票据」的集合
 * 放得比契约宽：显式入口带这种值时页面会进确认态，而真实链路一定失败（#258 复查 P1）。
 */
function asTicket(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null
  return ScanTicketSchema.safeParse(raw).success ? raw : null
}

/**
 * scene 入口：先按百分号编码解一次（微信把 scene 放在 query 里，编码 / 原样两种都收），
 * 解码失败就按原样走形状校验 —— 不是合法百分号编码的输入由形状门禁兜住。
 */
function fromScene(raw: string | undefined): string | null {
  if (!raw) return null
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // 场景值不是合法百分号编码：按原样继续解析
  }
  return asTicket(decoded)
}

export function parseLoginLaunch(params: Record<string, string | undefined>): LoginLaunch | null {
  // 显式参数**在场就由它定论**：它不合法说明这个链接本身是坏的（或被改过），
  // 此时再回退去用 scene 里的票，等于替用户猜一张别的票 —— 直接落「无效登录码」。
  // 微信出的小程序码只带 scene，所以两个入口同时在场只会来自页内跳转。
  if (params.ticket !== undefined) {
    const direct = asTicket(params.ticket)
    return direct === null ? null : { ticket: direct }
  }
  const scene = fromScene(params.scene)
  return scene !== null ? { ticket: scene } : null
}

/**
 * 页面的实际入口判定 = 参数解析 + **演示构建的补票**。
 *
 * 演示构建（`TARO_APP_MOCK=1`）没有电脑端真的出码，不带任何入口参数直接进本页时补一枚
 * 形状合法的演示票，让「确认 → 成功」动线在开发者工具里走得通。
 *
 * **只在入口什么都没给时才补**：给了 ticket / scene 却非法（坏二维码、被人改过的链接）
 * 必须照旧落「无效登录码」—— 否则演示构建里任意文本都会变成一张能确认的票，
 * 等于把这个页面唯一的失败态演示没了，真实构建的行为也无从对照。
 */
export function resolveLoginLaunch(
  params: Record<string, string | undefined>,
  demoEnabled: boolean,
): LoginLaunch | null {
  const parsed = parseLoginLaunch(params)
  if (parsed !== null) return parsed
  if (!demoEnabled) return null
  if (params.ticket !== undefined || params.scene !== undefined) return null
  return { ticket: DEMO_LOGIN_TICKET }
}

/**
 * 确认请求（`POST /auth/wechat/scan/ticket/:ticket/confirm`）失败后的三类走向。
 * 纯函数（Taro-free，有单测）：页面据此换面板或退回可重试态，判断逻辑不散在 JSX 里。
 */
export type ConfirmFailure =
  /** 票据死了（不存在 / 过期 / 已被兑换）→ 「无效登录码」面板 */
  | 'invalid'
  /** 票据已被**另一个**账号确认（409 `SCAN_TICKET_CONFLICT`）→ 「已被占用」面板 */
  | 'conflict'
  /** 其余（网络异常、401 会话失效、5xx…）→ 退回确认态给 toast；401 由请求层清会话后走守卫续接 */
  | 'retry'

/**
 * @param failure `isApiError(error)` 为真时传 `{ code }`，否则传 `null`。
 *   `@/lib/request` 的 `isApiError` 依赖 `@tarojs/taro`，在这里 import 会让本模块的
 *   单测跑不起来（同 `features/auth/login-messages.ts` 的拆分理由）。
 */
export function classifyConfirmFailure(failure: { code: string } | null): ConfirmFailure {
  if (failure === null) return 'retry'
  if (failure.code === 'SCAN_TICKET_INVALID') return 'invalid'
  if (failure.code === 'SCAN_TICKET_CONFLICT') return 'conflict'
  return 'retry'
}
