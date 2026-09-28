import { afterAll, describe, expect, test } from 'bun:test'
import { type EmbeddingProvider, EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
} from '@fish/contracts/embedding/text'
import { createDb } from '@fish/db/client'
import { findEmbedding } from '@fish/db/embedding-store'
import { newId } from '@fish/db/ids'
import { EMBEDDING_DIMENSIONS, embeddings } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq, inArray } from 'drizzle-orm'
import { InvalidJobPayloadError } from '../invalid-payload-error'
import { createEmbedJobHandlers, type EmbedRunResult } from './handlers'
import { createStubEmbeddingProvider, STUB_EMBEDDING_MODEL } from './providers/stub'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const createdUserIds: string[] = []

afterAll(async () => {
  // 删掉自己造的行：`wishes` / `listings` 上的 embeddings 由 ON DELETE CASCADE 带走。
  if (createdUserIds.length > 0) {
    await db.delete(wishes).where(inArray(wishes.userId, createdUserIds))
    await db.delete(listings).where(inArray(listings.sellerId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await db.$client.close()
})

let seq = 0

/**
 * `EmbedRunResult.contentHash` 在实体已被删除时是 null。断言落库指纹前先收紧类型，
 * 否则 bun:test 的 `toBe` 会因为 received 是 `string | undefined` 而拒绝 `string | null`。
 */
function expectHash(result: EmbedRunResult): string {
  if (result.contentHash === null) throw new Error('本用例期望生成结果带 contentHash')
  return result.contentHash
}

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `embed-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '向量 handler 测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  createdUserIds.push(row.id)
  return row.id
}

async function createListing(
  overrides: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId: overrides.sellerId ?? (await createUser()),
    title: 'K380 机械键盘',
    description: '青轴 95 新，附原装键帽',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    ...overrides,
  })
  return id
}

async function createWish(overrides: Partial<typeof wishes.$inferInsert> = {}): Promise<string> {
  const id = newId()
  await db.insert(wishes).values({
    id,
    userId: overrides.userId ?? (await createUser()),
    keyword: '苹果降噪耳机',
    description: '预算 1500 以内',
    category: 'DIGITAL',
    budgetMaxCents: 150000,
    ...overrides,
  })
  return id
}

/** 记录调用次数的包装：用来断言"内容没变就不重复调 provider"。 */
function counting(inner: EmbeddingProvider) {
  const state = { calls: 0 }
  const provider: EmbeddingProvider = {
    model: inner.model,
    dimensions: inner.dimensions,
    async embed(texts) {
      state.calls += 1
      return inner.embed(texts)
    },
  }
  return { provider, calls: () => state.calls }
}

function failing(reason: EmbeddingProviderError['reason'], model = STUB_EMBEDDING_MODEL) {
  const provider: EmbeddingProvider = {
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed() {
      throw new EmbeddingProviderError(reason, '上游不可用（测试注入）')
    },
  }
  return provider
}

const stub = createStubEmbeddingProvider()

describe('EMBED_LISTING', () => {
  test('首次运行生成向量：指纹来自 标题/描述/分类 文本，维度等于迁移里的 vector(N)', async () => {
    const listingId = await createListing()
    const handlers = createEmbedJobHandlers(db, stub)

    const result = await handlers.EMBED_LISTING({ listingId })

    expect(result).toEqual({
      entity: 'listing',
      status: 'generated',
      model: STUB_EMBEDDING_MODEL,
      contentHash: contentHashOf(
        buildListingEmbeddingText({
          title: 'K380 机械键盘',
          description: '青轴 95 新，附原装键帽',
          category: 'DIGITAL',
        }),
      ),
    })

    const row = await findEmbedding(db, { kind: 'listing', id: listingId }, STUB_EMBEDDING_MODEL)
    expect(row?.dimensions).toBe(EMBEDDING_DIMENSIONS)
    expect(row?.embedding).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(row?.contentHash).toBe(expectHash(result))
  })

  test('内容没变时第二次运行是 unchanged，且不再调用 provider（不重复计费）', async () => {
    const listingId = await createListing()
    const wrapped = counting(stub)
    const handlers = createEmbedJobHandlers(db, wrapped.provider)

    expect((await handlers.EMBED_LISTING({ listingId })).status).toBe('generated')
    expect((await handlers.EMBED_LISTING({ listingId })).status).toBe('unchanged')
    expect(wrapped.calls()).toBe(1)
  })

  test('编辑 title/description 后重算：指纹与向量都更新，同一实体仍只有一行', async () => {
    const listingId = await createListing()
    const handlers = createEmbedJobHandlers(db, stub)
    const entity = { kind: 'listing', id: listingId } as const

    const first = await handlers.EMBED_LISTING({ listingId })
    const before = await findEmbedding(db, entity, STUB_EMBEDDING_MODEL)

    await db
      .update(listings)
      .set({ title: 'AirPods Pro 2 USB-C', description: '全新未拆封，保修到明年' })
      .where(eq(listings.id, listingId))

    const second = await handlers.EMBED_LISTING({ listingId })
    expect(second.status).toBe('generated')
    expect(second.contentHash).not.toBe(first.contentHash)

    const after = await findEmbedding(db, entity, STUB_EMBEDDING_MODEL)
    expect(after?.contentHash).toBe(expectHash(second))
    // 覆盖而不是新增：旧 job 晚到不会留下第二行（唯一键 (listing_id, model)）。
    expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(1)
    expect(after?.embedding).not.toEqual(before?.embedding)
  })

  test('provider 失败时抛错且不写任何向量（绝不产生"空向量=正常匹配"）', async () => {
    const listingId = await createListing()
    const handlers = createEmbedJobHandlers(db, failing('timeout'))

    await expect(handlers.EMBED_LISTING({ listingId })).rejects.toThrow(EmbeddingProviderError)
    expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(0)
  })

  test('重算失败时旧向量原样保留（不会先删后写，旧向量仍可用于匹配）', async () => {
    const listingId = await createListing()
    const entity = { kind: 'listing', id: listingId } as const
    await createEmbedJobHandlers(db, stub).EMBED_LISTING({ listingId })
    const before = await findEmbedding(db, entity, STUB_EMBEDDING_MODEL)

    await db.update(listings).set({ title: '改过的标题' }).where(eq(listings.id, listingId))
    await expect(
      createEmbedJobHandlers(db, failing('network')).EMBED_LISTING({ listingId }),
    ).rejects.toThrow(EmbeddingProviderError)

    expect(await findEmbedding(db, entity, STUB_EMBEDDING_MODEL)).toEqual(before)
  })

  test('provider 声明维度不符时立即失败：不调用 provider、不写库', async () => {
    const listingId = await createListing()
    let calls = 0
    const wrongDeclared: EmbeddingProvider = {
      model: 'wrong-dim-v1',
      dimensions: 768,
      async embed() {
        calls += 1
        return [new Array<number>(768).fill(0.1)]
      },
    }

    await expect(
      createEmbedJobHandlers(db, wrongDeclared).EMBED_LISTING({ listingId }),
    ).rejects.toThrow(/维度不符/)
    expect(calls).toBe(0)
    expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(0)
  })

  test('provider 返回错维向量或非有限数值时拒绝写入', async () => {
    const listingId = await createListing()

    const shortVector: EmbeddingProvider = {
      model: 'short-vector-v1',
      dimensions: EMBEDDING_DIMENSIONS,
      async embed() {
        return [[1, 2, 3]]
      },
    }
    await expect(
      createEmbedJobHandlers(db, shortVector).EMBED_LISTING({ listingId }),
    ).rejects.toThrow(/向量维度不符/)

    const nanVector: EmbeddingProvider = {
      model: 'nan-vector-v1',
      dimensions: EMBEDDING_DIMENSIONS,
      async embed() {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
        vector[0] = Number.NaN
        return [vector]
      },
    }
    await expect(
      createEmbedJobHandlers(db, nanVector).EMBED_LISTING({ listingId }),
    ).rejects.toThrow(/非有限数值/)

    expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(0)
  })

  test('实体不存在时返回 missing（job 应 DONE：重试也找不回来）', async () => {
    const handlers = createEmbedJobHandlers(db, stub)
    expect(await handlers.EMBED_LISTING({ listingId: newId() })).toEqual({
      entity: 'listing',
      status: 'missing',
      model: STUB_EMBEDDING_MODEL,
      contentHash: null,
    })
    expect(await handlers.EMBED_WISH({ wishId: newId() })).toEqual({
      entity: 'wish',
      status: 'missing',
      model: STUB_EMBEDDING_MODEL,
      contentHash: null,
    })
  })

  test('payload 非法时抛 InvalidJobPayloadError（FATAL，不重试）', async () => {
    const handlers = createEmbedJobHandlers(db, stub)
    for (const payload of [
      {},
      { listingId: 'not-a-uuid' },
      { listingId: newId(), extra: 1 },
      null,
    ]) {
      await expect(handlers.EMBED_LISTING(payload)).rejects.toBeInstanceOf(InvalidJobPayloadError)
    }
    // 交叉 payload 也必须被拒：EMBED_WISH 只认 wishId。
    await expect(handlers.EMBED_WISH({ listingId: newId() })).rejects.toBeInstanceOf(
      InvalidJobPayloadError,
    )
  })
})

describe('EMBED_WISH', () => {
  test('用 需求/描述/分类 文本生成；category 为空时写「不限」', async () => {
    const wishId = await createWish({ category: null })
    const handlers = createEmbedJobHandlers(db, stub)

    const result = await handlers.EMBED_WISH({ wishId })

    expect(result.status).toBe('generated')
    const row = await findEmbedding(db, { kind: 'wish', id: wishId }, STUB_EMBEDDING_MODEL)
    expect(row?.contentHash).toBe(
      contentHashOf(
        buildWishEmbeddingText({
          keyword: '苹果降噪耳机',
          description: '预算 1500 以内',
          category: null,
        }),
      ),
    )
    // 向量落在 wishes 那一侧，而不是 listing_id。
    expect(await db.$count(embeddings, eq(embeddings.wishId, wishId))).toBe(1)
  })

  test('wish 与 listing 的文本构造互不串味：同一关键词下两个指纹不同', async () => {
    const listingId = await createListing()
    const wishId = await createWish()
    const handlers = createEmbedJobHandlers(db, stub)

    const listingRun = await handlers.EMBED_LISTING({ listingId })
    const wishRun = await handlers.EMBED_WISH({ wishId })

    expect(listingRun.contentHash).not.toBe(wishRun.contentHash)
  })

  test('编辑 keyword 后重算（愿望侧同样有失效语义）', async () => {
    const wishId = await createWish()
    const handlers = createEmbedJobHandlers(db, stub)

    const first = await handlers.EMBED_WISH({ wishId })
    expect((await handlers.EMBED_WISH({ wishId })).status).toBe('unchanged')

    await db.update(wishes).set({ keyword: '索尼降噪头戴' }).where(eq(wishes.id, wishId))
    const second = await handlers.EMBED_WISH({ wishId })

    expect(second.status).toBe('generated')
    expect(second.contentHash).not.toBe(first.contentHash)
    expect(await db.$count(embeddings, eq(embeddings.wishId, wishId))).toBe(1)
  })
})
