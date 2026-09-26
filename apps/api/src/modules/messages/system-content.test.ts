import { expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId as newUuid } from '@fish/db/ids'
import { idRekeys } from '@fish/db/schema/id-rekeys'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq } from 'drizzle-orm'
import { createSystemContentProjector, projectSystemContent } from './system-content'

const oldId = '01930000-0000-4000-8000-000000000051'
const newId = '01930000-0000-7000-8000-000000000051'

test('旧交易系统消息只在公开出口重映射；其他消息不改写', async () => {
  const stored = JSON.stringify({ type: 'tx.accepted', transactionId: oldId, amountCents: 15000 })
  expect(
    JSON.parse(
      await projectSystemContent('SYSTEM', stored, async (id) => {
        expect(id).toBe(oldId)
        return newId
      }),
    ),
  ).toEqual({
    type: 'tx.accepted',
    transactionId: encodePublicId(PUBLIC_ID_PREFIX.transaction, newId),
    amountCents: 15000,
  })
  expect(JSON.parse(stored)).toMatchObject({ transactionId: oldId })
  expect(
    await projectSystemContent('TEXT', stored, async () => {
      throw new Error('不应查库')
    }),
  ).toBe(stored)
  expect(await projectSystemContent('SYSTEM', stored, async () => null)).not.toContain(oldId)
})

test('历史交易 ID 在真实映射表中查询，公开消息指向新的订单且不修改存储内容', async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('集成测试需要 DATABASE_URL')
  const db = createDb(databaseUrl)
  const legacy = crypto.randomUUID()
  const current = newUuid()
  const stored = JSON.stringify({ type: 'tx.accepted', transactionId: legacy, amountCents: 100 })
  try {
    await db
      .insert(idRekeys)
      .values({ resourceTable: 'transactions', oldId: legacy, newId: current })
    const projected = await createSystemContentProjector(db)('SYSTEM', stored)
    expect(JSON.parse(projected)).toMatchObject({
      transactionId: encodePublicId(PUBLIC_ID_PREFIX.transaction, current),
      amountCents: 100,
    })
    expect(JSON.parse(stored)).toMatchObject({ transactionId: legacy })
  } finally {
    await db
      .delete(idRekeys)
      .where(and(eq(idRekeys.resourceTable, 'transactions'), eq(idRekeys.oldId, legacy)))
    await db.$client.close()
  }
})
