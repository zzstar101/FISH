import { loadMailTransportEnv, loadMeetupTokenEnv, loadServerEnv } from '@fish/shared/env'
import { createApp } from './app'
import { websocket } from './ws'

const env = loadServerEnv()
// 邮件 transport 配置在启动时显式校验（MAIL_TRANSPORT 必填，缺配置立即失败，不静默降级）。
const mailEnv = loadMailTransportEnv()
// 面交码签名密钥同属 API 专属配置（#70，worker 不做 HMAC），缺配置/强度不足立即失败。
const meetupEnv = loadMeetupTokenEnv()
const app = createApp(env, mailEnv, meetupEnv)

const server = Bun.serve({
  port: env.API_PORT,
  fetch: app.fetch,
  websocket,
})

console.log(`[api] listening on http://localhost:${server.port}`)
