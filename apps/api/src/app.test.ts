import { describe, expect, test } from 'bun:test'
import { HealthResponseSchema } from '@fish/contracts/system/health'
import { loadServerEnv } from '@fish/shared/env'
import { createApp } from './app'

const hasDatabase = Boolean(process.env.DATABASE_URL)

describe('GET /health', () => {
  // 需要 Postgres：本地先 `bun run db:up`，CI 由 workflow 的 postgres service 提供。
  test.skipIf(!hasDatabase)('returns a valid ok response when postgres is reachable', async () => {
    const app = createApp(loadServerEnv())
    const res = await app.request('/health')

    expect(res.status).toBe(200)

    const body = HealthResponseSchema.parse(await res.json())
    expect(body.status).toBe('ok')
    expect(body.db.status).toBe('up')
  })
})
