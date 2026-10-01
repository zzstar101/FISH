import {
  loadAiPolishEnv,
  loadContentModerationEnv,
  loadMailTransportEnv,
  loadMeetupTokenEnv,
  loadServerEnv,
  loadVisualEmbeddingEnv,
  loadVisualParseEnv,
  loadWechatEnv,
} from '@fish/shared/env'
import { createApp } from './app'
import { normalizeIp } from './modules/listings/trusted-ip'
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
)

server = Bun.serve({
  port: env.API_PORT,
  fetch: app.fetch,
  websocket,
})

console.log(`[api] listening on http://localhost:${server.port}`)
