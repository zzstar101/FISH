import {
  loadAiPolishEnv,
  loadContentModerationEnv,
  loadMailTransportEnv,
  loadMeetupTokenEnv,
  loadServerEnv,
  loadSubscribeMessageTemplatesEnv,
  loadVisualEmbeddingEnv,
  loadVisualParseEnv,
  loadWechatEnv,
} from '@fish/shared/env'
import { createApp } from './app'
import { API_HTTP_IDLE_TIMEOUT_SECONDS } from './modules/auth/phone-bind-budget'
import { normalizeIp } from './modules/listings/trusted-ip'
import type { SubscribeMessageScheduler } from './modules/subscribe-messages/scheduler'
import { websocket } from './ws'

const env = loadServerEnv()
// 邮件 transport 配置在启动时显式校验（MAIL_TRANSPORT 必填，缺配置立即失败，不静默降级）。
const mailEnv = loadMailTransportEnv()
// 面交码签名密钥同属 API 专属配置（#70，worker 不做 HMAC），缺配置/强度不足立即失败。
const meetupEnv = loadMeetupTokenEnv()
// AI 润色上游配置（#141）：transport 无默认值，live 缺任一项启动即失败。
const aiEnv = loadAiPolishEnv()
// 微信身份配置（#86 评审 P1）：transport 无默认值（off/stub/live），生产禁 stub；
// off 时登录/绑定入口 503 关闭，不静默降级 stub。
const wechatEnv = loadWechatEnv()
// 内容安全审核配置（#228）：transport 无默认值，生产禁 local；缺腾讯配置启动即失败。
// #286 起该配置被真正消费：图片 confirm 会用它构造 provider 做内容审核并固化 final 对象。
const moderationEnv = loadContentModerationEnv()
// 拍照识图搜索的视觉向量化（#324 M3）：transport 无默认值（stub/live），生产禁 stub；
// live 时 baseUrl / apiKey / model 缺一即启动失败。stub 只给本机与测试用。
const visualEmbeddingEnv = loadVisualEmbeddingEnv()
// OCR/VLM 语义解析（#324 M5）：未设置即 `off`——只做图片向量召回，不产生第二次上游调用，
// 也就不会把查询图再发一次。开启（live）后文本路才参与召回。
const visualParseEnv = loadVisualParseEnv()
// 微信订阅消息模板（#462）：三个都可选，缺项即"该 kind 未开通"。填了但形状不对（手抄模板 ID
// 最常见的错法）在启动时直接失败，而不是等投递时拿到 47003/40037 才分不清是模板错了还是平台故障。
const subscribeTemplatesEnv = loadSubscribeMessageTemplatesEnv()

// 假数据可见性第三件（设计 §8.2）：stub 时在启动日志里明确警告，避免部署方以为在跑真模型。
if (aiEnv.transport === 'stub') {
  console.warn('[api] AI_POLISH_TRANSPORT=stub：润色返回的是演示文案，不是真实模型输出')
}
// 同款警告：stub 微信身份不验证微信签发的凭证，只用于本地开发/测试。
if (wechatEnv.transport === 'stub') {
  console.warn('[api] WECHAT_TRANSPORT=stub：微信登录/手机号绑定走演示凭证，不验证微信签发')
}
// 同款警告：local 走本地词表，图片不审内容，只适合本地开发/测试。
// 图片仍然可以确认（会固化），但结论恒为 REVIEW，商品会进人工队列，不会被当成审核通过。
if (moderationEnv.transport === 'local') {
  console.warn(
    '[api] CONTENT_MODERATION_TRANSPORT=local：文本走本地词表、图片不做内容审核（一律进人工队列），不是内容安全审核',
  )
}

const proxyIp = process.env.LISTING_LOOKUP_TRUSTED_PROXY_IP ?? null
if (proxyIp !== null && normalizeIp(proxyIp) === null) {
  throw new Error('LISTING_LOOKUP_TRUSTED_PROXY_IP 必须是规范 IPv4/IPv6 地址')
}
let server: ReturnType<typeof Bun.serve>
// 订阅消息的投递循环（#462）：`createApp` 只造调度器并经 `lifecycle` 交出，启动与停止属于进程。
//
// 用可变**容器**而不是裸 `let`：赋值发生在 `createApp` 的回调里，TS 的控制流分析看不到那次
// 赋值，裸 `let` 会被窄化成 `null`（`.start()` 直接报 "Property 'start' does not exist on type
// 'never'"）。属性读取不做这种窄化。
const lifecycle: { subscribeScheduler: SubscribeMessageScheduler | null } = {
  subscribeScheduler: null,
}
const app = createApp(
  env,
  mailEnv,
  meetupEnv,
  aiEnv,
  wechatEnv,
  {
    peerIp: (request) => server?.requestIP(request)?.address ?? null,
    trustedProxyIp: proxyIp,
  },
  moderationEnv,
  visualEmbeddingEnv,
  visualParseEnv,
  subscribeTemplatesEnv,
  {
    onSubscribeScheduler: (scheduler) => {
      lifecycle.subscribeScheduler = scheduler
    },
  },
)

server = Bun.serve({
  port: env.API_PORT,
  fetch: app.fetch,
  websocket,
  // 默认 10s 会掐断「手机号绑定」的最坏路径（上游 20s：取 token 5s + 换号 5s，凭证失效再各
  // 一次），客户端收到 ECONNRESET 而号码其实已经落库。取值与上游预算、客户端超时三者对齐，
  // 推导见 `modules/auth/phone-bind-budget.ts`；WebSocket 用的是另一个定时器（不受影响）。
  idleTimeout: API_HTTP_IDLE_TIMEOUT_SECONDS,
})

console.log(`[api] listening on http://localhost:${server.port}`)

/*
 * 投递循环在监听之后启动（#462）：它每轮都会打数据库，起得比 `Bun.serve` 早只会让"启动日志"
 * 与实际可服务时刻错位。能力未开通时 `start()` 只记一行日志、不建定时器。
 *
 * 退出必须显式 `stop()` **并等它返回**（#511 审查 high）：`setInterval` 会一直挂在事件循环上，
 * SIGTERM 后进程本可以退出，却因为定时器还在而拖到平台强杀；而清掉定时器就 `process.exit()`
 * 更糟 —— 那一轮可能正有一条投递在调微信，微信收到了、本地事务还没提交，重启后同一条会被
 * 再发一次。`stop()` 因此是异步的：它关掉"开新工作"的入口，再等最多 `STOP_TIMEOUT_MS` 让
 * 在途那条落定。SIGINT/SIGTERM 都按 0 退出，部署侧的滚动重启不会把"正常停机"记成失败。
 */
lifecycle.subscribeScheduler?.start()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (lifecycle.subscribeScheduler?.stop() ?? Promise.resolve())
      .catch((error: unknown) => {
        console.error('[api] 停机时停止订阅消息循环失败', error)
      })
      .finally(() => process.exit(0))
  })
}
