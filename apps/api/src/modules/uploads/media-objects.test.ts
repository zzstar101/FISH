import { expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { users } from '@fish/db/schema/users'
import { eq } from 'drizzle-orm'
import { createSqlListingMediaObjectStore, type ListingMediaObjectInsert } from './media-objects'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlListingMediaObjectStore(db)

let seq = 0

async function createUser(client: Db): Promise<string> {
  const rows = await client
    .insert(users)
    .values({
      studentNo: `listing-media-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '集成测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

/** 每个用例自建、自清自己的数据；`listing_media_objects.user_id` 是级联删除。 */
async function withUser(run: (userId: string) => Promise<void>) {
  const userId = await createUser(db)
  try {
    await run(userId)
  } finally {
    await db.delete(users).where(eq(users.id, userId))
  }
}

function mediaObject(
  userId: string,
  overrides: Partial<ListingMediaObjectInsert> = {},
): ListingMediaObjectInsert {
  return {
    userId,
    stagingKey: `listing-media/${userId}/${newId()}.jpg`,
    finalKey: `listings/${userId}/${newId()}.jpg`,
    contentDigest: 'a'.repeat(64),
    providerMd5: 'c'.repeat(32),
    moderationDecision: 'ALLOW',
    provider: 'TENCENT_IMS',
    providerRequestId: 'req-1',
    ...overrides,
  }
}

test('落库后按 (userId, stagingKey, contentDigest) 幂等查回', async () => {
  await withUser(async (userId) => {
    const input = mediaObject(userId)
    const row = await store.insert(input)
    expect(row?.finalKey).toBe(input.finalKey)

    const found = await store.findByDigest({
      userId,
      stagingKey: input.stagingKey,
      contentDigest: input.contentDigest,
    })
    expect(found?.finalKey).toBe(input.finalKey)
    expect(found?.moderationDecision).toBe('ALLOW')
    expect(found?.providerMd5).toBe('c'.repeat(32))

    // staging 对象被 PUT 覆盖成别的内容 ⇒ 摘要不同 ⇒ 查不到 ⇒ 必须重新审核
    expect(
      await store.findByDigest({
        userId,
        stagingKey: input.stagingKey,
        contentDigest: 'b'.repeat(64),
      }),
    ).toBeNull()
    // 同一个 staging 键换了归属也不复用别人的结论
    expect(
      await store.findByDigest({
        userId: '01930000-0000-7000-8000-0000000000ff',
        stagingKey: input.stagingKey,
        contentDigest: input.contentDigest,
      }),
    ).toBeNull()
  })
})

test('并发 confirm 撞唯一索引时 insert 返回 null 而不是抛错', async () => {
  await withUser(async (userId) => {
    const input = mediaObject(userId)
    expect(await store.insert(input)).not.toBeNull()
    // 第二次写同一份结论：唯一索引挡下，调用方据此改用先落库那一行的 final 键
    expect(await store.insert(input)).toBeNull()

    const found = await store.findByDigest({
      userId,
      stagingKey: input.stagingKey,
      contentDigest: input.contentDigest,
    })
    expect(found?.finalKey).toBe(input.finalKey)
  })
})

test('findConfirmedFinalKey 回带归属与结论，未知键返回 null', async () => {
  await withUser(async (userId) => {
    const finalKey = `listings/${userId}/${newId()}.jpg`
    const input = mediaObject(userId, { finalKey, moderationDecision: 'REVIEW' })
    await store.insert(input)

    expect(await store.findConfirmedFinalKey(finalKey)).toEqual({
      userId,
      finalKey,
      moderationDecision: 'REVIEW',
    })
    expect(await store.findConfirmedFinalKey(`listings/${userId}/${newId()}.jpg`)).toBeNull()
    // staging 键不是可引用键
    expect(await store.findConfirmedFinalKey(input.stagingKey)).toBeNull()
  })
})

// 引用校验的"安全关键"判定不依赖上游写库时没写错：即使库里出现带 final 键的 BLOCK 行，
// 也只认非 BLOCK 的结论。
test('findConfirmedFinalKey 排除 BLOCK 行', async () => {
  await withUser(async (userId) => {
    const blocked = mediaObject(userId, { moderationDecision: 'BLOCK' })
    const row = await store.insert(blocked)
    expect(row?.finalKey).toBe(blocked.finalKey)

    const finalKey = blocked.finalKey
    expect(finalKey).not.toBeNull()
    expect(await store.findConfirmedFinalKey(finalKey ?? '')).toBeNull()
  })
})

test('DB 约束挡住越界数据（非 BLOCK 必须有 final 键 / 摘要与 MD5 形状 / staging 前缀）', async () => {
  await withUser(async (userId) => {
    await expect(
      store.insert(mediaObject(userId, { moderationDecision: 'ALLOW', finalKey: null })),
    ).rejects.toThrow()
    await expect(
      store.insert(mediaObject(userId, { contentDigest: 'not-a-digest' })),
    ).rejects.toThrow()
    await expect(store.insert(mediaObject(userId, { providerMd5: 'xyz' }))).rejects.toThrow()
    await expect(
      store.insert(mediaObject(userId, { stagingKey: `staging/${userId}/x.jpg` })),
    ).rejects.toThrow()
  })
})
