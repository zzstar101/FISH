import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { createMatchJobHandlers, InvalidJobPayloadError } from './handlers'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
afterAll(async () => {
  await db.$client.close()
})

const handlers = createMatchJobHandlers(db)

/**
 * `Backend Done` 的第 2 条："双方向匹配均可独立触发"——这里就是不经过应用入口、
 * 直接调用 handler 的验证方式（不依赖 #7 是否接了 `MATCH_WISH` 的生产者）。
 *
 * 用一个不存在的 id：引擎返回 `target-missing`，不会写任何行，所以不需要清理。
 */
describe('createMatchJobHandlers', () => {
  test('两个方向都能被独立调用，目标不存在时是 no-op', async () => {
    const expected = {
      evaluated: 0,
      matched: 0,
      created: 0,
      downgraded: 0,
      skipped: 'target-missing' as const,
    }
    expect(await handlers.MATCH_LISTING({ listingId: newId() })).toEqual(expected)
    expect(await handlers.MATCH_WISH({ wishId: newId() })).toEqual(expected)
  })

  // 契约 §3.5：坏 payload 要让 job 直接 FAILED，而不是静默跳过或按"另一个字段"理解。
  test('坏 payload 抛 InvalidJobPayloadError（多余字段 / 缺字段 / 类型不符 / 方向串了）', async () => {
    const badPayloads: Array<[keyof typeof handlers, unknown]> = [
      ['MATCH_LISTING', { listingId: newId(), userId: newId() }],
      ['MATCH_LISTING', {}],
      ['MATCH_LISTING', { listingId: 'not-a-uuid' }],
      ['MATCH_LISTING', { wishId: newId() }],
      ['MATCH_WISH', { listingId: newId() }],
      ['MATCH_WISH', { wishId: 42 }],
    ]

    for (const [type, payload] of badPayloads) {
      await expect(handlers[type](payload)).rejects.toBeInstanceOf(InvalidJobPayloadError)
    }
  })
})
