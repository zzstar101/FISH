import {
  loadAiPolishEnv,
  loadMailTransportEnv,
  loadMeetupTokenEnv,
  loadServerEnv,
} from '@fish/shared/env'
import { createApp } from './app'
import { websocket } from './ws'

const env = loadServerEnv()
// 邮件 transport 配置在启动时显式校验（MAIL_TRANSPORT 必填，缺配置立即失败，不静默降级）。
const mailEnv = loadMailTransportEnv()
// 面交码签名密钥同属 API 专属配置（#70，worker 不做 HMAC），缺配置/强度不足立即失败。
const meetupEnv = loadMeetupTokenEnv()
// AI 润色上游配置（#141）：transport 无默认值，live 缺任一项启动即失败。
const aiEnv = loadAiPolishEnv()

// 假数据可见性第三件（设计 §8.2）：stub 时在启动日志里明确警告，避免部署方以为在跑真模型。
if (aiEnv.transport === 'stub') {
  console.warn('[api] AI_POLISH_TRANSPORT=stub：润色返回的是演示文案，不是真实模型输出')
}

const app = createApp(env, mailEnv, meetupEnv, aiEnv)

const server = Bun.serve({
  port: env.API_PORT,
  fetch: app.fetch,
  websocket,
})

console.log(`[api] listening on http://localhost:${server.port}`)
