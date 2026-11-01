import { WECHAT_PLATFORM_TIMEOUT_MS } from '../wechat/access-token'

/**
 * 「手机号绑定」这条链路的**时间预算**，以及由它反推出来的 HTTP 连接超时。
 *
 * 为什么单独一个模块：这三层超时（上游总预算 / 服务端连接超时 / 客户端请求超时）必须互相对齐，
 * 少对齐一层就会出现「客户端报网络异常、号码其实已经落库」这种用户与服务端事实不一致的状态
 * （审查复现：默认 10s 的 `Bun.serve` idleTimeout 在 18.8s 的处理器上先掐断连接，客户端收到
 * ECONNRESET，而处理器随后完成并写库）。数字放在这里，`index.ts` 与测试都从同一处取值。
 *
 * 三者的大小关系（`phone-bind-budget.test.ts` 钉住）：
 *
 * ```text
 * 上游总预算 20s  ≤  服务端预算 21s  ≤  服务端 idleTimeout 22s  <  客户端超时 25s
 * ```
 */

/**
 * 一次绑定最多打几趟上游：初次一趟 + 「凭证失效（40001/40014/42001）换 token 重试」一趟。
 * 与 `wechat-phone.ts` 的 `resolve()` 一一对应 —— 那里只有这两趟，没有第三趟。
 */
export const PHONE_BIND_UPSTREAM_ATTEMPTS = 2

/**
 * 每趟上游的两个串行步骤：先取 `access_token`（`tokens.get()`），再换号
 * （`getuserphonenumber`）。两者各自受 `WECHAT_PLATFORM_TIMEOUT_MS` 约束，串行执行。
 */
export const PHONE_BIND_STEPS_PER_ATTEMPT = 2

/**
 * 上游总预算（毫秒）= 趟数 × 每趟步骤 × 单步超时 = 2 × 2 × 5s = 20s。
 *
 * 这是**上界**而不是耗时：正常路径窗口内缓存命中 token 时只有一趟换号（≤5s）。
 */
export const PHONE_BIND_UPSTREAM_BUDGET_MS =
  PHONE_BIND_UPSTREAM_ATTEMPTS * PHONE_BIND_STEPS_PER_ATTEMPT * WECHAT_PLATFORM_TIMEOUT_MS

/** 上游之后的本地处理留量：写 `users.phone`、序列化响应、连接上的杂项开销。 */
export const PHONE_BIND_LOCAL_ALLOWANCE_MS = 1000

/** 服务端处理这条请求的最坏耗时：上游总预算 + 本地留量 = 21s。 */
export const PHONE_BIND_SERVER_BUDGET_MS =
  PHONE_BIND_UPSTREAM_BUDGET_MS + PHONE_BIND_LOCAL_ALLOWANCE_MS

/**
 * `Bun.serve` 的连接空闲超时（秒，Bun 只接受整数秒）。
 *
 * 必须**不小于**服务端预算（21s），否则最坏路径上连接会先被掐断。取 22s 而不是 21s：整数秒
 * 向上取整，留 1s 的抖动余量。它仍远小于客户端超时（25s），所以客户端总能拿到服务端的真实结果。
 *
 * 影响面：
 * - **WebSocket 不受影响**：连接超时与 `websocket.idleTimeout`（Bun 默认 120s、本仓未改）是
 *   两个独立定时器，实测把 `idleTimeout` 压到 2s 也不影响空闲 WS 连接；
 * - **其它路由不受影响**：它们都远快于 22s，只是「空闲 keep-alive 连接」与「慢处理器」被允许
 *   活得更久一点，不再被默认的 10s 提前掐断。
 */
export const API_HTTP_IDLE_TIMEOUT_SECONDS = Math.ceil(PHONE_BIND_SERVER_BUDGET_MS / 1000) + 1
