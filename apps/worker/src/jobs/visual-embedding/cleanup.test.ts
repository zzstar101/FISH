import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { visualQueryImages } from '@fish/db/schema/visual-query-images'
import { eq, like } from 'drizzle-orm'
import type { WorkerMediaStorage } from '../../media-storage'
import { cleanupExpiredVisualQueryImages, VISUAL_QUERY_CLEANUP_BATCH_SIZE } from './cleanup'

// 与 #322 文本侧同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

/**
 * 用"过去的 now"把本文件的行与真实时间线隔开：清理是**全表**扫描（只看 `expires_at`），
 * 而这个库里其它行的到期时刻都在当下之后，所以只有本文件造的行会 `< NOW`，
 * `scanned` / `deleted` 才能断言成精确值。
 */
const NOW = new Date('2020-01-01T00:00:00.000Z')

function expiredAt(minutesAgo: number): Date {
  return new Date(NOW.getTime() - minutesAgo * 60_000)
}

function notExpiredAt(minutesAhead: number): Date {
  return new Date(NOW.getTime() + minutesAhead * 60_000)
}

const KEY_PREFIX = 'visual-search/cleanup-test-'
let seq = 0

function makeKey(label: string): string {
  return `${KEY_PREFIX}${label}-${seq++}`
}

type RowFixture = { objectKey: string; expiresAt: Date }

async function insertRows(rows: RowFixture[]): Promise<void> {
  await db.insert(visualQueryImages).values(
    rows.map((row) => ({
      id: newId(),
      objectKey: row.objectKey,
      subjectType: 'user',
      subjectKey: 'cleanup-test-subject',
      contentType: 'image/png',
      sizeBytes: 1024,
      expiresAt: row.expiresAt,
    })),
  )
}

/**
 * 记录 `deleteObject` 的调用顺序，并在**调用那一刻**回查台账，作为"对象先于行删除"的证据：
 * 如果实现先把行删了，这里就会记录到 `rowPresent=false`。
 */
function recordingStorage(log: string[]): WorkerMediaStorage {
  return {
    async readBytes() {
      return null
    },
    async deleteObject(key) {
      const present = await db.$count(visualQueryImages, eq(visualQueryImages.objectKey, key))
      log.push(`deleteObject:${key}:rowPresent=${present > 0}`)
    },
  }
}

function rowCount(key: string): Promise<number> {
  return db.$count(visualQueryImages, eq(visualQueryImages.objectKey, key))
}

afterEach(async () => {
  // 只清本文件命名空间的行；前缀独一无二，不会碰别人的数据。
  await db.delete(visualQueryImages).where(like(visualQueryImages.objectKey, `${KEY_PREFIX}%`))
})

afterAll(async () => {
  await db.delete(visualQueryImages).where(like(visualQueryImages.objectKey, `${KEY_PREFIX}%`))
  await db.$client.close()
})

describe('cleanupExpiredVisualQueryImages', () => {
  test('只删到期行：未到期的一行原样保留', async () => {
    const expiredKey = makeKey('expired')
    const liveKey = makeKey('live')
    await insertRows([
      { objectKey: expiredKey, expiresAt: expiredAt(60) },
      { objectKey: liveKey, expiresAt: notExpiredAt(60) },
    ])

    const log: string[] = []
    const result = await cleanupExpiredVisualQueryImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })

    expect(result).toEqual({ scanned: 1, deleted: 1 })
    expect(log).toEqual([`deleteObject:${expiredKey}:rowPresent=true`])
    // 未到期的行必须还在，且到期时刻没被动过。
    expect(await rowCount(liveKey)).toBe(1)
    expect(await rowCount(expiredKey)).toBe(0)
  })

  test('先删对象再删行：deleteObject 执行时台账行仍在', async () => {
    const key = makeKey('order')
    await insertRows([{ objectKey: key, expiresAt: expiredAt(30) }])

    const log: string[] = []
    const result = await cleanupExpiredVisualQueryImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })

    expect(result).toEqual({ scanned: 1, deleted: 1 })
    // rowPresent=true 只在"先删对象"的实现下成立：顺序一旦反了，这里会是 false。
    expect(log).toEqual([`deleteObject:${key}:rowPresent=true`])
    expect(await rowCount(key)).toBe(0)
  })

  test('deleteObject 抛错：行不删、错误冒出，下一轮重试同一行', async () => {
    const key = makeKey('throwing')
    await insertRows([{ objectKey: key, expiresAt: expiredAt(10) }])

    const failing: WorkerMediaStorage = {
      async readBytes() {
        return null
      },
      async deleteObject() {
        throw new Error('对象删除失败')
      },
    }

    await expect(
      cleanupExpiredVisualQueryImages({ db, storage: failing, now: NOW }),
    ).rejects.toThrow('对象删除失败')

    // 对象删失败时绝不能删行：行一删，这个键就永远没人记得删了。
    expect(await rowCount(key)).toBe(1)

    // 下一轮重新捡起同一行（对象恢复可删）。
    const log: string[] = []
    const result = await cleanupExpiredVisualQueryImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })
    expect(result).toEqual({ scanned: 1, deleted: 1 })
    expect(log).toEqual([`deleteObject:${key}:rowPresent=true`])
    expect(await rowCount(key)).toBe(0)
  })

  test('返回值与处理量一致，且按 expires_at 升序删除', async () => {
    const oldest = makeKey('t1')
    const middle = makeKey('t2')
    const newest = makeKey('t3')
    await insertRows([
      { objectKey: middle, expiresAt: expiredAt(20) },
      { objectKey: newest, expiresAt: expiredAt(10) },
      { objectKey: oldest, expiresAt: expiredAt(30) },
    ])

    const log: string[] = []
    const result = await cleanupExpiredVisualQueryImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })

    expect(result).toEqual({ scanned: 3, deleted: 3 })
    // 先到期的先删：对象删除顺序必须与 expires_at 升序一致。
    expect(log).toEqual([
      `deleteObject:${oldest}:rowPresent=true`,
      `deleteObject:${middle}:rowPresent=true`,
      `deleteObject:${newest}:rowPresent=true`,
    ])
    expect(await rowCount(oldest)).toBe(0)
    expect(await rowCount(middle)).toBe(0)
    expect(await rowCount(newest)).toBe(0)
  })

  test('limit 生效：3 条到期行 + limit 2 → 只删最早到期的 2 条', async () => {
    const oldest = makeKey('limit-oldest')
    const middle = makeKey('limit-middle')
    const newest = makeKey('limit-newest')
    await insertRows([
      { objectKey: newest, expiresAt: expiredAt(10) },
      { objectKey: oldest, expiresAt: expiredAt(30) },
      { objectKey: middle, expiresAt: expiredAt(20) },
    ])

    const log: string[] = []
    const result = await cleanupExpiredVisualQueryImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
      limit: 2,
    })

    expect(result.scanned).toBeLessThanOrEqual(2)
    expect(result).toEqual({ scanned: 2, deleted: 2 })
    expect(log).toEqual([
      `deleteObject:${oldest}:rowPresent=true`,
      `deleteObject:${middle}:rowPresent=true`,
    ])
    // 剩下的是到期最晚的那条，下一轮再清。
    expect(await rowCount(newest)).toBe(1)
  })

  test('不给 limit 时用 VISUAL_QUERY_CLEANUP_BATCH_SIZE 作为默认上限', async () => {
    expect(VISUAL_QUERY_CLEANUP_BATCH_SIZE).toBeGreaterThan(0)

    // 多造一行：默认值若没生效（例如退化成不限量），scanned 就会是 batch + 1。
    const total = VISUAL_QUERY_CLEANUP_BATCH_SIZE + 1
    await insertRows(
      Array.from({ length: total }, (_, index) => ({
        objectKey: makeKey(`batch-${index}`),
        expiresAt: expiredAt(index + 1),
      })),
    )

    const log: string[] = []
    const result = await cleanupExpiredVisualQueryImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })

    expect(result).toEqual({
      scanned: VISUAL_QUERY_CLEANUP_BATCH_SIZE,
      deleted: VISUAL_QUERY_CLEANUP_BATCH_SIZE,
    })
    // 每个被删的行都真的删了对象，不是只删了台账。
    expect(log).toHaveLength(VISUAL_QUERY_CLEANUP_BATCH_SIZE)
    // 正好剩一行没清（下一轮处理）。
    expect(
      await db.$count(visualQueryImages, like(visualQueryImages.objectKey, `${KEY_PREFIX}%`)),
    ).toBe(total - VISUAL_QUERY_CLEANUP_BATCH_SIZE)
  })
})
