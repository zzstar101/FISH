import { expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { ModerationSettlementError, type ModerationStore } from '../moderation/store'
import { createSqlAdminStore } from './store'

// #286 复审：图片结算拒绝人工放行时会抛错让决策事务回滚，admin store 必须把它翻译成结果码，
// 否则管理员看到的是 500 而不是可解释的 409。这里只测这条翻译路径（moderation 为注入的替身，
// 因此不需要任何业务夹具；`db` 是真的，用来跑事务与审计幂等查询）。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

function storeWith(decideWithin: ModerationStore['decideWithin']) {
  const moderation: ModerationStore = {
    listByListing: async () => [],
    getById: async () => null,
    decideWithin,
  }
  return createSqlAdminStore(db, moderation)
}

function input() {
  return {
    recordId: '00000000-0000-7000-8000-000000000000',
    actorUserId: '00000000-0000-7000-8000-000000000001',
    decision: 'ALLOW' as const,
    reason: '集成测试',
    requestId: `admin-settlement-test-${crypto.randomUUID()}`,
  }
}

test('结算判定"图已被人工阻断"时返回 media-blocked（决策事务整体回滚）', async () => {
  const store = storeWith(async () => {
    throw new ModerationSettlementError('IMAGE_BLOCKED', '审核图片已被人工阻断')
  })

  expect(await store.decideModeration(input())).toBe('media-blocked')
})

test('结算过程失败（对象/台账缺失）时返回 media-settlement-failed', async () => {
  const store = storeWith(async () => {
    throw new ModerationSettlementError('SETTLEMENT_FAILED', '审核图片对象缺失')
  })

  expect(await store.decideModeration(input())).toBe('media-settlement-failed')
})

test('与结算无关的异常不被吞掉（仍然是服务端错误，而不是"决策未生效"）', async () => {
  const store = storeWith(async () => {
    throw new Error('boom')
  })

  await expect(store.decideModeration(input())).rejects.toThrow('boom')
})
