import { expect, test } from 'bun:test'
import { createDb } from './client'
import { conversations } from './schema/conversations'
import { jobs } from './schema/jobs'
import { listingImages, listings } from './schema/listings'
import { matches } from './schema/matches'
import { messages } from './schema/messages'
import { notifications } from './schema/notifications'
import { transactions } from './schema/transactions'
import { users } from './schema/users'
import { wishes } from './schema/wishes'
import { seed } from './seed'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

/** 在事务里跑 seed 并回滚：既不污染开发库，又能断言生成结果。 */
class RollbackSeed extends Error {}

test('seed 可生成覆盖全部 10 张表的基础数据', async () => {
  const counts: Record<string, number> = {}

  await expect(
    db.transaction(async (tx) => {
      await seed(tx)

      for (const [name, table] of Object.entries({
        users,
        listings,
        listingImages,
        wishes,
        matches,
        conversations,
        messages,
        transactions,
        notifications,
        jobs,
      })) {
        counts[name] = await tx.$count(table)
      }

      // 首页数据必须能查到
      const activeListings = await tx.$count(listings)
      expect(activeListings).toBeGreaterThan(0)

      throw new RollbackSeed()
    }),
  ).rejects.toBeInstanceOf(RollbackSeed)

  expect(counts).toEqual({
    users: 3,
    listings: 6,
    listingImages: 4,
    wishes: 2,
    matches: 1,
    conversations: 1,
    messages: 2,
    transactions: 2,
    notifications: 1,
    jobs: 1,
  })
})
