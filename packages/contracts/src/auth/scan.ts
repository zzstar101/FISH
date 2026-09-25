import { z } from 'zod'
import { AuthResponseSchema } from './session'
import { MeSchema } from './user'

/**
 * 小程序码扫码登录契约（#197，2026-09-25 冻结）。
 *
 * 链路：Web 建票出码 → 小程序扫码确认 → 服务端把票据绑到**当前小程序用户** →
 * Web 凭仅自己持有的 `verifier` 一次性兑换成浏览器会话。
 *
 * 安全边界：
 * - `ticket` 印在二维码里，**是公开的**；真正防止他人顶替的是浏览器独占的 `verifier`，
 *   它只经 `SCAN_VERIFIER_HEADER` 传输，绝不进 URL（避免落进 access log / referer / 历史）。
 * - 库内只存两者的 SHA-256；明文只出现在「建票响应」与「查状态 / 兑换请求的请求头」，
 *   不落日志。
 * - **对外错误码不区分**「不存在 / verifier 错 / 过期 / 已消费」，一律 `SCAN_TICKET_INVALID`，
 *   否则这个匿名可调的端点就成了票据枚举接口。只有持正确 verifier 的调用者才拿得到
 *   `ScanTicketStatusSchema` 里的细化状态。
 * - 本链路不碰 openid：它复用小程序**已有的 FISH 会话**，微信身份解析仍归 `wechat.ts`。
 *
 * 长度约束来自微信官方（`getUnlimitedQRCode` 的 `scene` 最大 32 个可见字符，且不支持 `%`）：
 * 16 随机字节的 base64url 恰好 22 字符，留 10 字符余量，字符集 `A-Za-z0-9-_` 全在白名单内。
 */

/**
 * 四个端点的形状总览（T5 按此接线）：
 *
 * | 端点 | 鉴权 | 请求 | 成功响应 |
 * | --- | --- | --- | --- |
 * | `POST /auth/wechat/scan/ticket` | 匿名 | 空体 | `ScanTicketResponseSchema` |
 * | `GET /auth/wechat/scan/ticket/:ticket` | `SCAN_VERIFIER_HEADER` | 路径参数 | `ScanTicketStatusResponseSchema` |
 * | `POST /auth/wechat/scan/ticket/:ticket/confirm` | 会话 cookie | 空体 + 路径参数 | **204，无响应体** |
 * | `POST /auth/wechat/scan/ticket/:ticket/exchange` | `SCAN_VERIFIER_HEADER` | 空体 + 路径参数 | `ScanExchangeResponseSchema` + `Set-Cookie` |
 *
 * 三个带路径参数的端点共用 `ScanTicketParamSchema`。`confirm` **刻意没有响应体**：
 * 确认页要展示的账号来自它自己的会话，回一个恒为真的字段没有信息量；失败一律走错误码。
 * 成功状态码与错误码的对应关系见本文件末尾的 `ScanErrorCodeSchema`。
 *
 * **四个端点都必须下发 `Cache-Control: no-store`**（T5 接线时强制）。状态接口是
 * 带 `X-Scan-Verifier` 的 GET、路径里只有公开 ticket：共享缓存若只按 URL 建键，就会把
 * `confirmed` 连同 `user` 交给 verifier 不对的调用者——那正好绕过「只有持正确 verifier
 * 才看得到细化状态」这条冻结项。
 *
 * **部署层义务：不得把 `/auth/wechat/scan/ticket/*` 的完整 path 写进 access log**，
 * 或在写入前对该段做脱敏。#197 冻结的候选端点形状把 ticket 放在 path 上（`.../:ticket`），
 * 而 issue 同时要求「日志不泄漏票据」——本仓 API 自身没有请求日志中间件，因此这条
 * 只能由反向代理/网关的日志配置兑现，接线时（T5）必须一并确认。
 */

/** 印在二维码 scene 里的公开票据。 */
export const ScanTicketSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/, 'ticket 必须是 22 字符 base64url')

export type ScanTicket = z.infer<typeof ScanTicketSchema>

/** 发起这次登录的浏览器独占的兑换凭据；32 字节的 hex。 */
export const ScanVerifierSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'verifier 必须是 64 字符小写 hex')

export type ScanVerifier = z.infer<typeof ScanVerifierSchema>

/** `verifier` 的传输位置：请求头而不是 query（不进 URL 就不会进日志与浏览器历史）。 */
export const SCAN_VERIFIER_HEADER = 'X-Scan-Verifier'

/**
 * 扫码后要打开的小程序页面。放在契约里是因为它有**两个消费方**：API 用 `getUnlimitedQRCode`
 * 的 `page` 出码、小程序侧保证这个页面存在——两边各写一份字符串迟早会漂移。
 * 不带前导 `/`，也不能带参数（参数只能放进 `scene`，微信官方要求）。
 */
export const SCAN_CONFIRM_PAGE = 'pages/login-confirm/index'

/** 访问路径参数里的 ticket 与请求头里的 verifier，服务端用同一个形状门禁。 */
export const ScanTicketParamSchema = z.strictObject({ ticket: ScanTicketSchema })

/** 扫码票据的细化状态；只有持正确 verifier 的调用者可见。 */
export const ScanTicketStatusSchema = z.enum(['pending', 'confirmed', 'expired'])

export type ScanTicketStatus = z.infer<typeof ScanTicketStatusSchema>

/**
 * 确认弹窗要展示的最小账号投影：用 `.pick()` 派生而不是重写，避免与认证域漂移。
 * 刻意比 `ListingSellerSchema` 更窄（那个还带 `authStatus`）：扫码确认只需要「是谁」，
 * `authStatus` / `verifiedAt` / 手机号派生态都不进这条响应。
 */
export const ScanUserSchema = MeSchema.pick({ id: true, nickname: true, avatarUrl: true })

export type ScanUser = z.infer<typeof ScanUserSchema>

/**
 * 小程序码图片：`live` 下是微信返回的二进制转出的 data URL，`stub` 下为 `null`
 * （没有 AppSecret 就生成不了真码，此时端上展示 ticket 并提示用开发者工具以
 * `scene=<ticket>` 打开确认页，**不用普通二维码冒充会误导**）。
 *
 * 只接受 `image/*` 的 base64 data URL：空串、随便一个字符串、或 `data:text/html;...`
 * 都必须被拒——否则「取码失败」会伪装成一次成功的建票响应，前端也无从区分
 * 「stub 的 null」与「真的没拿到码」。
 */
export const ScanQrDataUrlSchema = z
  .string()
  .regex(
    /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+$/i,
    '必须是小程序码图片的 base64 data URL',
  )
  .nullable()

/**
 * 建票响应。`verifier` 只在这个响应里出现一次，客户端必须只留在内存
 * （落 storage 等于把「换会话的凭据」交给 XSS）。
 */
export const ScanTicketResponseSchema = z.object({
  ticket: ScanTicketSchema,
  verifier: ScanVerifierSchema,
  qrCodeDataUrl: ScanQrDataUrlSchema,
  expiresAt: z.iso.datetime(),
})

export type ScanTicketResponse = z.infer<typeof ScanTicketResponseSchema>

/**
 * 状态轮询响应。刻意用 `discriminatedUnion` 而不是 `user?:`：
 * `confirmed` 时 Web 要展示「即将登录为 X」并据此做二次确认，所以 `user` 是**必填**的。
 * `pending` / `expired` 分支没有这个字段，即使上游多带了也会被 zod 剥掉（响应 schema 不做
 * `.strict()`，与 `MeSchema` 同一取舍），因此解析结果里「user 只可能出现在 confirmed」。
 */
export const ScanTicketStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), expiresAt: z.iso.datetime() }),
  z.object({ status: z.literal('expired'), expiresAt: z.iso.datetime() }),
  z.object({
    status: z.literal('confirmed'),
    expiresAt: z.iso.datetime(),
    user: ScanUserSchema,
  }),
])

export type ScanTicketStatusResponse = z.infer<typeof ScanTicketStatusResponseSchema>

/**
 * 兑换成功 = 登录成功，因此与 `/auth/login`、`/auth/wechat/session` 同构（同一个 `{ user: Me }`），
 * 前端可以直接写进 `auth` 的 `me` 缓存，不必再打一次 `/me`。会话 cookie 由 API 层落 `Set-Cookie`。
 */
export const ScanExchangeResponseSchema = AuthResponseSchema

export type ScanExchangeResponse = z.infer<typeof ScanExchangeResponseSchema>

/**
 * 扫码登录子域错误码。与前两个认证子域（`session.ts` / `verification.ts`）合并成
 * `AuthErrorCodeAllSchema` 交给 auth 模块收窄。
 */
export const ScanErrorCodeSchema = z.enum([
  /** 404：不存在 / verifier 错 / 过期 / 已消费——四种原因刻意合并，杜绝匿名枚举。 */
  'SCAN_TICKET_INVALID',
  /** 409：这张票已经绑给了**另一个**用户，不能被改绑。 */
  'SCAN_TICKET_CONFLICT',
  /**
   * 502：平台侧取码失败。最常见的成因是「接口只能生成**已发布**小程序的二维码」这条硬前置
   * 未满足——它与 503 `WECHAT_DISABLED`（transport 未开通）是两件事，端上引导也不同。
   */
  'WECHAT_QR_UNAVAILABLE',
])

export type ScanErrorCode = z.infer<typeof ScanErrorCodeSchema>
