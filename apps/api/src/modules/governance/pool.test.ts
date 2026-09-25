import { expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createRestrictionGuard, type RestrictionVariables } from './guard'
import { createSqlGovernanceStore } from './store'

test('守卫池耗尽时，业务写入仍能从独立池取得连接并结束', async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('集成测试需要 DATABASE_URL')
  const guardDb = createDb(url, { max: 2 })
  const writerDb = createDb(url, { max: 1 })
  const app = new Hono<{ Variables: RestrictionVariables }>()
  const guard = createRestrictionGuard({ store: createSqlGovernanceStore(guardDb) })
  let arrived = 0
  let release: () => void = () => {}
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve
  })
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-test-user-id') ?? '')
    await next()
  })
  app.post('/write', guard.write, async (c) => {
    if (++arrived === 2) release()
    await bothArrived
    await writerDb.execute(sql`SELECT pg_sleep(0.04)`)
    return c.json({ ok: true })
  })
  try {
    const requests = [newId(), newId()].map((userId) =>
      Promise.resolve(
        app.request('/write', { method: 'POST', headers: { 'x-test-user-id': userId } }),
      ),
    )
    const responses = await Promise.race([
      Promise.all(requests),
      Bun.sleep(2500).then(() => {
        throw new Error('业务写入等待池连接时发生自阻塞')
      }),
    ])
    expect(arrived).toBe(2)
    expect(responses.map((response) => response.status)).toEqual([200, 200])
  } finally {
    await guardDb.$client.close()
    await writerDb.$client.close()
  }
})
