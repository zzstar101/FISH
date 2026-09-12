import { loadServerEnv } from '@fish/shared/env'
import { createApp } from './app'
import { websocket } from './ws'

const env = loadServerEnv()
const app = createApp(env)

const server = Bun.serve({
  port: env.API_PORT,
  fetch: app.fetch,
  websocket,
})

console.log(`[api] listening on http://localhost:${server.port}`)
