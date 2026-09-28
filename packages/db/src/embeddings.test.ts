import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb, type Db } from './client'
import {
  findEmbedding,
  hasEmbeddingFromOtherModel,
  saveEmbedding,
  topKSimilarListings,
  topKSimilarWishes,
} from './embedding-store'
import { newId } from './ids'
import { EMBEDDING_DIMENSIONS, embeddings } from './schema/embeddings'
import { listings } from './schema/listings'
import { users } from './schema/users'
import { wishes } from './schema/wishes'
import { reserveTestListingNo } from './testing/listing-no'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))

/**
 * 与 `seed.test.ts` 同套路：独立 scratch 库，既不碰开发库，也不受其他测试文件的
 * 顺序/并发方式影响；顺带在**空库**上验证一次"迁移能在新库装上 pgvector"。
 */
const scratchDatabase = `fish_embeddings_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

/** 只是拿它当"建/删库"的执行通道，所有断言都在 scratch 库上。 */
const admin = createDb(databaseUrl)

const MODEL = 'stub-deterministic-v1'
const OTHER_MODEL = 'another-model-v2'
const ISOLATED_CATEGORY = 'OTHER'

/**
 * 写入 CAS 的实体版本（"读实体那一刻的 updated_at"）。测试里显式给两个固定版本，不依赖真实
 * `updated_at` 的毫秒抖动，才能把"旧版本写入被拒绝"钉死。
 */
const V1 = new Date('2026-01-01T00:00:00.000Z')
const V2 = new Date('2026-01-02T00:00:00.000Z')

let db: Db
let seq = 0

/**
 * 断言一段 SQL 被数据库拒绝：drizzle 的 `db.execute()` 返回 PgRaw（自定义 thenable），
 * bun:test 的 `expect(...).rejects` 只认原生 Promise，所以这里自己 await 并检查错误消息。
 * drizzle 会把驱动错误包成 `Failed query: …`（真正的原因在 `cause` 链上），所以要整链匹配。
 */
async function expectSqlRejected(run: () => unknown, pattern: RegExp): Promise<string> {
  try {
    await run()
  } catch (error) {
    const messages: string[] = []
    let current: unknown = error
    for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
      if (current instanceof Error) {
        messages.push(current.message)
        current = current.cause
      } else {
        messages.push(String(current))
        break
      }
    }
    const chain = messages.join('\n')
    expect(chain).toMatch(pattern)
    return chain
  }
  throw new Error(`期望 SQL 被拒绝（${pattern}），但执行成功了`)
}

/** 单位向量：第 `axis` 维为 1，其余为 0。float4 往返精确，余弦距离可手算。 */
function unitVector(axis: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  vector[axis] = 1
  return vector
}

/** `unitVector(0)` 与 `unitVector(1)` 的等权混合：与查询向量 `unitVector(0)` 的余弦距离约 0.2929。 */
function mixedVector(): number[] {
  const scale = 1 / Math.sqrt(2)
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  vector[0] = scale
  vector[1] = scale
  return vector
}

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `embeddings-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '向量测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

async function createListing(sellerId: string): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title: `向量测试商品 ${seq++}`,
    description: 'pgvector 存取测试',
    priceCents: 9900,
    category: ISOLATED_CATEGORY,
    condition: 'GOOD',
  })
  return id
}

async function createWish(userId: string): Promise<string> {
  const id = newId()
  await db.insert(wishes).values({
    id,
    userId,
    keyword: `向量测试愿望 ${seq++}`,
    budgetMaxCents: 20000,
    category: ISOLATED_CATEGORY,
  })
  return id
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

test('迁移在新库装上 pgvector 扩展，且 embedding 列是 vector(EMBEDDING_DIMENSIONS)', async () => {
  const extension = await db.execute<{ extversion: string }>(
    sql`select extversion from pg_extension where extname = 'vector'`,
  )
  // 只断言"扩展存在"是不够的：镜像里扩展可用，但 `CREATE EXTENSION` 必须真的执行过。
  expect([...extension]).toHaveLength(1)

  const column = await db.execute<{ type: string }>(sql`
    select format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
    where a.attrelid = 'embeddings'::regclass
      and a.attname = 'embedding'
      and not a.attisdropped
  `)
  // typmod 必须与 TS 常量一致：换了维度只改常量而不重新生成迁移，这里立刻红。
  expect([...column][0]?.type).toBe(`vector(${EMBEDDING_DIMENSIONS})`)
})

test('写入后能按 (实体, model) 读回同一向量；别的 model 读不到', async () => {
  const sellerId = await createUser()
  const listingId = await createListing(sellerId)

  await saveEmbedding(db, {
    entity: { kind: 'listing', id: listingId },
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'hash-a',
    embedding: unitVector(7),
    sourceUpdatedAt: V1,
  })

  const found = await findEmbedding(db, { kind: 'listing', id: listingId }, MODEL)
  expect(found).toEqual({
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'hash-a',
    embedding: unitVector(7),
    sourceUpdatedAt: V1,
  })
  // 读侧必须显式带 model：否则换模型期间会静默读到另一种向量。
  expect(await findEmbedding(db, { kind: 'listing', id: listingId }, OTHER_MODEL)).toBeNull()
})

test('同实体同 model 重复写入是更新而不是新增（旧 job 晚到不会留下第二行）', async () => {
  const sellerId = await createUser()
  const listingId = await createListing(sellerId)
  const entity = { kind: 'listing', id: listingId } as const

  await saveEmbedding(db, {
    entity,
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'hash-old',
    embedding: unitVector(1),
    sourceUpdatedAt: V1,
  })
  // 更高的实体版本覆盖旧的：返回值 true 表示这次写入真的生效了。
  expect(
    await saveEmbedding(db, {
      entity,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: 'hash-new',
      embedding: unitVector(2),
      sourceUpdatedAt: V2,
    }),
  ).toBe(true)

  // `saveEmbedding` 的 ON CONFLICT 打在 partial unique index (listing_id, model) 上：
  // 这条断言同时验证了 drizzle 的 `targetWhere` 在 bun-sql 下确实生成了合法 SQL。
  const rows = await db
    .select({ contentHash: embeddings.contentHash })
    .from(embeddings)
    .where(eq(embeddings.listingId, listingId))
  expect(rows).toEqual([{ contentHash: 'hash-new' }])

  const found = await findEmbedding(db, entity, MODEL)
  expect(found?.embedding).toEqual(unitVector(2))
})

test('CAS：基于旧版本的写入被整条拒绝，不会把新内容向量改回旧的（#322 验收）', async () => {
  const sellerId = await createUser()
  const listingId = await createListing(sellerId)
  const entity = { kind: 'listing', id: listingId } as const

  // 新版本（编辑后的内容）先落库。
  expect(
    await saveEmbedding(db, {
      entity,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: 'hash-new',
      embedding: unitVector(9),
      sourceUpdatedAt: V2,
    }),
  ).toBe(true)

  // 旧 job 晚到：它携带的是 V1 版本，写入必须被 `excluded.source_updated_at >= 目标列` 拒绝。
  expect(
    await saveEmbedding(db, {
      entity,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: 'hash-old',
      embedding: unitVector(8),
      sourceUpdatedAt: V1,
    }),
  ).toBe(false)

  const found = await findEmbedding(db, entity, MODEL)
  expect(found?.contentHash).toBe('hash-new')
  expect(found?.embedding).toEqual(unitVector(9))
  expect(found?.sourceUpdatedAt.getTime()).toBe(V2.getTime())
  expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(1)

  // 同版本重写是幂等的（等于"同一个 job 又跑了一次"），不应被 CAS 挡掉。
  expect(
    await saveEmbedding(db, {
      entity,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: 'hash-new',
      embedding: unitVector(9),
      sourceUpdatedAt: V2,
    }),
  ).toBe(true)
  expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(1)
})

test('CAS 在愿望侧同样生效（两个方向的写入规则必须一致）', async () => {
  const userId = await createUser()
  const wishId = await createWish(userId)
  const entity = { kind: 'wish', id: wishId } as const

  await saveEmbedding(db, {
    entity,
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'wish-new',
    embedding: unitVector(10),
    sourceUpdatedAt: V2,
  })
  expect(
    await saveEmbedding(db, {
      entity,
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: 'wish-old',
      embedding: unitVector(11),
      sourceUpdatedAt: V1,
    }),
  ).toBe(false)

  expect((await findEmbedding(db, entity, MODEL))?.contentHash).toBe('wish-new')
})

test('同一实体允许新旧模型并存（换模型不覆盖旧向量，读侧按 model 选择）', async () => {
  const sellerId = await createUser()
  const listingId = await createListing(sellerId)
  const entity = { kind: 'listing', id: listingId } as const

  await saveEmbedding(db, {
    entity,
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'hash-old-model',
    embedding: unitVector(3),
    sourceUpdatedAt: V1,
  })
  await saveEmbedding(db, {
    entity,
    model: OTHER_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'hash-new-model',
    embedding: unitVector(4),
    sourceUpdatedAt: V1,
  })

  expect((await findEmbedding(db, entity, MODEL))?.contentHash).toBe('hash-old-model')
  expect((await findEmbedding(db, entity, OTHER_MODEL))?.contentHash).toBe('hash-new-model')
  expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(2)
})

test('CHECK：必须且只能属于一个实体（两个都空 / 两个都填都写不进去）', async () => {
  const sellerId = await createUser()
  const listingId = await createListing(sellerId)
  const userId = await createUser()
  const wishId = await createWish(userId)
  const vector = JSON.stringify(unitVector(0))

  const bothNull = db.execute(sql`
    insert into embeddings (listing_id, wish_id, model, dimensions, content_hash, embedding, source_updated_at)
    values (null, null, ${MODEL}, ${EMBEDDING_DIMENSIONS}, 'h', ${vector}::vector, now())
  `)
  await expectSqlRejected(() => bothNull, /embeddings_exactly_one_entity/)

  const bothSet = db.execute(sql`
    insert into embeddings (listing_id, wish_id, model, dimensions, content_hash, embedding, source_updated_at)
    values (${listingId}, ${wishId}, ${MODEL}, ${EMBEDDING_DIMENSIONS}, 'h', ${vector}::vector, now())
  `)
  await expectSqlRejected(() => bothSet, /embeddings_exactly_one_entity/)
})

test('维度护栏：vector 列拒绝错维向量，dimensions 列必须等于 EMBEDDING_DIMENSIONS', async () => {
  const sellerId = await createUser()
  const listingId = await createListing(sellerId)

  // provider 报错维度时 handler 会先拒绝；这里是 DB 层的最后一道护栏（typmod）。
  const wrongDimensions = db.execute(sql`
    insert into embeddings (listing_id, model, dimensions, content_hash, embedding, source_updated_at)
    values (${listingId}, ${MODEL}, ${EMBEDDING_DIMENSIONS}, 'h', '[1,2,3]'::vector, now())
  `)
  await expectSqlRejected(() => wrongDimensions, /expected 1536 dimensions/)

  const wrongDeclared = db.execute(sql`
    insert into embeddings (listing_id, model, dimensions, content_hash, embedding, source_updated_at)
    values (${listingId}, ${MODEL}, 768, 'h', ${JSON.stringify(unitVector(0))}::vector, now())
  `)
  await expectSqlRejected(() => wrongDeclared, /embeddings_dimensions_matches_column/)
})

test('删除父实体时 embedding 随 CASCADE 清理，不留孤儿', async () => {
  const sellerId = await createUser()
  const listingId = await createListing(sellerId)
  const userId = await createUser()
  const wishId = await createWish(userId)

  await saveEmbedding(db, {
    entity: { kind: 'listing', id: listingId },
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'hash-listing',
    embedding: unitVector(5),
    sourceUpdatedAt: V1,
  })
  await saveEmbedding(db, {
    entity: { kind: 'wish', id: wishId },
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: 'hash-wish',
    embedding: unitVector(6),
    sourceUpdatedAt: V1,
  })

  await db.delete(listings).where(eq(listings.id, listingId))
  await db.delete(wishes).where(eq(wishes.id, wishId))

  expect(await db.$count(embeddings, eq(embeddings.listingId, listingId))).toBe(0)
  expect(await db.$count(embeddings, eq(embeddings.wishId, wishId))).toBe(0)
  expect(await findEmbedding(db, { kind: 'listing', id: listingId }, MODEL)).toBeNull()
})

test('cosine Top-K 顺序有固定 fixture：`<=>` 的排序与距离值都被钉住', async () => {
  const sellerId = await createUser()
  const near = await createListing(sellerId)
  const far = await createListing(sellerId)
  const middle = await createListing(sellerId)

  for (const [listingId, embedding] of [
    [near, unitVector(0)],
    [far, unitVector(1)],
    [middle, mixedVector()],
  ] as const) {
    await saveEmbedding(db, {
      entity: { kind: 'listing', id: listingId },
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      contentHash: `hash-${listingId}`,
      embedding: [...embedding],
      sourceUpdatedAt: V1,
    })
  }

  const queryVector = unitVector(0)
  // `round(...::numeric, 4)` 会返回字符串并把 "0.0000" 压成 "0"，所以再转 float8 拿数值比较。
  const ranked = await db.execute<{ listingId: string; distance: number }>(sql`
    select ${embeddings.listingId} as "listingId",
           round((${embeddings.embedding} <=> ${JSON.stringify(queryVector)}::vector)::numeric, 4)::float8 as distance
    from ${embeddings}
    where ${embeddings.listingId} in (${near}, ${far}, ${middle})
    order by ${embeddings.embedding} <=> ${JSON.stringify(queryVector)}::vector
  `)

  // 距离值是手算 fixture：同向 0，正交 1，等权混合 1 - 1/√2 ≈ 0.2929。
  // M2 的 Top-K 召回直接建立在这个顺序上，所以这里把顺序与数值一起钉死。
  expect([...ranked]).toEqual([
    { listingId: near, distance: 0 },
    { listingId: middle, distance: 0.2929 },
    { listingId: far, distance: 1 },
  ])
})

// ---------------------------------------------------------------------------
// #322 M2：向量召回（`topKSimilar*` / `hasEmbeddingFromOtherModel`）
//
// 这些查询是"结构化过滤 → cosine Top-K"里的第二步。测试把 `filter` 参数用起来，
// 正是为了钉死**结构化条件在 Top-K 之前生效**（被过滤掉的最近候选不占名额）。
// ---------------------------------------------------------------------------

/** 带指定向量的愿望（`keyword` 用来做隔离过滤，所以不能复用 `createWish` 的自动命名）。 */
async function createWishWithEmbedding(
  userId: string,
  keyword: string,
  embedding: number[],
  model = MODEL,
): Promise<string> {
  const id = newId()
  await db.insert(wishes).values({
    id,
    userId,
    keyword,
    budgetMaxCents: 20000,
    category: ISOLATED_CATEGORY,
  })
  await saveEmbedding(db, {
    entity: { kind: 'wish', id },
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: `hash-${id}`,
    embedding,
    sourceUpdatedAt: V1,
  })
  return id
}

/** 带指定向量的商品（同上，`title` 既当内容也当隔离过滤条件）。 */
async function createListingWithEmbedding(
  sellerId: string,
  title: string,
  embedding: number[],
  model = MODEL,
): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title,
    description: 'Top-K 召回测试',
    priceCents: 9900,
    category: ISOLATED_CATEGORY,
    condition: 'GOOD',
  })
  await saveEmbedding(db, {
    entity: { kind: 'listing', id },
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: `hash-${id}`,
    embedding,
    sourceUpdatedAt: V1,
  })
  return id
}

test('topKSimilarWishes：按 cosine 距离升序取前 K，且只认指定 model 的向量', async () => {
  const owner = await createUser()
  const marker = `topk-wish-${seq++}`
  const near = await createWishWithEmbedding(owner, `${marker}-near`, unitVector(0))
  const middle = await createWishWithEmbedding(owner, `${marker}-middle`, mixedVector())
  const far = await createWishWithEmbedding(owner, `${marker}-far`, unitVector(1))
  // 只有**别的** model 的向量：绝不能出现在本 model 的召回里（否则就是静默混用两套向量）。
  const otherModel = await createWishWithEmbedding(
    owner,
    `${marker}-other`,
    unitVector(0),
    OTHER_MODEL,
  )
  // 根本没有向量：同样不出现。
  const noVector = await createWish(owner)

  const filter = sql`${wishes.keyword} like ${`${marker}%`}`
  const ranked = await topKSimilarWishes(db, {
    model: MODEL,
    vector: unitVector(0),
    limit: 10,
    filter,
  })

  expect(ranked.map((row) => row.id)).toEqual([near, middle, far])
  expect(ranked[0]?.distance).toBe(0)
  expect(ranked[1]?.distance).toBeCloseTo(0.2929, 4)
  expect(ranked[2]?.distance).toBe(1)

  // LIMIT 就是 K：候选池大小由它决定。
  const limited = await topKSimilarWishes(db, {
    model: MODEL,
    vector: unitVector(0),
    limit: 2,
    filter,
  })
  expect(limited.map((row) => row.id)).toEqual([near, middle])
  expect(limited.map((row) => row.id)).not.toContain(otherModel)
  expect(limited.map((row) => row.id)).not.toContain(noVector)
})

test('topKSimilarWishes：结构化收窄在 Top-K 之前生效，被过滤的最近候选不占名额', async () => {
  const owner = await createUser()
  const marker = `topk-filter-${seq++}`
  // 最近的候选会被 filter 排除；如果先取 Top-K 再过滤，`allowed` 就会被挤出 K。
  await createWishWithEmbedding(owner, `${marker}-nearest`, unitVector(0))
  const allowed = await createWishWithEmbedding(owner, `${marker}-allowed`, mixedVector())

  const ranked = await topKSimilarWishes(db, {
    model: MODEL,
    vector: unitVector(0),
    limit: 1,
    filter: sql`${wishes.keyword} = ${`${marker}-allowed`}`,
  })

  expect(ranked.map((row) => row.id)).toEqual([allowed])
  expect(ranked[0]?.distance).toBeCloseTo(0.2929, 4)
})

test('topKSimilarListings：与愿望方向同一套语义（model 过滤、排序、LIMIT 一致）', async () => {
  const sellerId = await createUser()
  const marker = `topk-listing-${seq++}`
  const near = await createListingWithEmbedding(sellerId, `${marker}-near`, unitVector(3))
  const far = await createListingWithEmbedding(sellerId, `${marker}-far`, unitVector(4))
  const otherModel = await createListingWithEmbedding(
    sellerId,
    `${marker}-other`,
    unitVector(3),
    OTHER_MODEL,
  )

  const filter = sql`${listings.title} like ${`${marker}%`}`
  const ranked = await topKSimilarListings(db, {
    model: MODEL,
    vector: unitVector(3),
    limit: 10,
    filter,
  })

  expect(ranked.map((row) => row.id)).toEqual([near, far])
  expect(ranked[0]?.distance).toBe(0)
  expect(ranked[1]?.distance).toBe(1)

  const limited = await topKSimilarListings(db, {
    model: MODEL,
    vector: unitVector(3),
    limit: 1,
    filter,
  })
  expect(limited.map((row) => row.id)).toEqual([near])
  expect(limited.map((row) => row.id)).not.toContain(otherModel)
})

test('hasEmbeddingFromOtherModel：区分“从没生成过”与“只有旧 model 的向量”', async () => {
  const sellerId = await createUser()
  const never = await createListing(sellerId)
  const oldOnly = await createListing(sellerId)
  const current = await createListing(sellerId)

  await saveEmbedding(db, {
    entity: { kind: 'listing', id: oldOnly },
    model: OTHER_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: `hash-${oldOnly}`,
    embedding: unitVector(5),
    sourceUpdatedAt: V1,
  })
  await saveEmbedding(db, {
    entity: { kind: 'listing', id: current },
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: `hash-${current}`,
    embedding: unitVector(5),
    sourceUpdatedAt: V1,
  })

  // 引擎靠它把 fallbackReason 分成 'missing'（该补投 EMBED job）与 'model-mismatch'（换模型了，别当成没生成过）。
  expect(await hasEmbeddingFromOtherModel(db, { kind: 'listing', id: never }, MODEL)).toBe(false)
  expect(await hasEmbeddingFromOtherModel(db, { kind: 'listing', id: oldOnly }, MODEL)).toBe(true)
  expect(await hasEmbeddingFromOtherModel(db, { kind: 'listing', id: current }, MODEL)).toBe(false)
  // 愿望方向同一实现。
  const wishId = await createWishWithEmbedding(
    sellerId,
    `topk-other-model-${seq++}`,
    unitVector(5),
    OTHER_MODEL,
  )
  expect(await hasEmbeddingFromOtherModel(db, { kind: 'wish', id: wishId }, MODEL)).toBe(true)
})
