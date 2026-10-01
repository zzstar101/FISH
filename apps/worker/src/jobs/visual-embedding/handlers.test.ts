import { afterAll, describe, expect, test } from 'bun:test'
import { EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import { VISUAL_EMBED_JOB_TYPES } from '@fish/contracts/visual/jobs'
import type { VisualEmbeddingProvider, VisualImageMime } from '@fish/contracts/visual/provider'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { findVisualEmbedding } from '@fish/db/visual-embedding-store'
import { and, eq, inArray } from 'drizzle-orm'
import type { WorkerMediaStorage } from '../../media-storage'
import { InvalidJobPayloadError } from '../invalid-payload-error'
import { createVisualEmbedJobHandlers, VisualSourceImageError } from './handlers'

// 与 #322 文本侧同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const createdUserIds: string[] = []
const createdListingIds: string[] = []

afterAll(async () => {
  // 删 listings 时 `listing_images` / `listing_visual_embeddings` 由 ON DELETE CASCADE 带走。
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds))
    // `listing_numbers` 是 append-only 的独立预约表（没有指向 listings 的 FK），要显式清掉。
    await db.delete(listingNumbers).where(inArray(listingNumbers.listingId, createdListingIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await db.$client.close()
})

let seq = 0

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `visual-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '视觉向量 handler 测试',
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
  createdListingIds.push(id)
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

/** 封面 = `sort_order = 0` 的那一张；handler 只认它，所以测试必须显式造出这一行。 */
async function addImage(listingId: string, objectKey: string, sortOrder: number): Promise<void> {
  await db.insert(listingImages).values({ listingId, objectKey, sortOrder })
}

async function listingUpdatedAt(listingId: string): Promise<Date> {
  const rows = await db
    .select({ updatedAt: listings.updatedAt })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error('listings 行不存在')
  return row.updatedAt
}

/** 只关心魔术字节：8 字节 PNG 签名 / JPEG 的 FF D8 FF 就够嗅探了。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

function fakeStorage(bytes: Uint8Array | null): WorkerMediaStorage {
  return {
    async readBytes() {
      return bytes
    },
    async deleteObject() {},
  }
}

/**
 * 1024 维里只动前两维。pgvector 是 float4：1 与 0.5 都能精确往返，避免浮点误差让 toEqual 变脆。
 */
function testVector(): number[] {
  const vector = new Array<number>(VISUAL_EMBEDDING_DIMENSIONS).fill(0)
  vector[0] = 1
  vector[1] = 0.5
  return vector
}

/** 记录调用的 provider：用来断言"没变就不调"以及"传进去的是封面字节 + 嗅探出的 MIME"。 */
function recordingProvider(model: string, embedImage: (bytes: Uint8Array) => Promise<number[]>) {
  const state: { calls: number; image: Uint8Array | null; mime: VisualImageMime | null } = {
    calls: 0,
    image: null,
    mime: null,
  }
  const provider: VisualEmbeddingProvider = {
    model,
    dimensions: VISUAL_EMBEDDING_DIMENSIONS,
    async embedImage(image, mime) {
      state.calls += 1
      state.image = image
      state.mime = mime
      return embedImage(image)
    },
    async embedText() {
      throw new Error('视觉 handler 不应调用 embedText')
    },
  }
  return {
    provider,
    calls: () => state.calls,
    image: () => state.image,
    mime: () => state.mime,
  }
}

function listingHandler(provider: VisualEmbeddingProvider, storage: WorkerMediaStorage) {
  return createVisualEmbedJobHandlers(db, provider, storage)[VISUAL_EMBED_JOB_TYPES.listing]
}

/** 捕获抛出的错误做类型收窄；调用没抛错说明用例前提不成立。 */
async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error('本用例期望抛错，但调用成功返回了')
}

function expectProviderError(error: unknown, reason: EmbeddingProviderError['reason']): void {
  if (!(error instanceof EmbeddingProviderError)) {
    throw new Error(`期望 EmbeddingProviderError，实际是 ${String(error)}`)
  }
  expect(error.reason).toBe(reason)
}

describe('VISUAL_EMBED_LISTING', () => {
  test('Listing 不存在 → missing：不调 provider、不写行（job 应 DONE）', async () => {
    const recorder = recordingProvider('missing-v1', async () => testVector())
    const missingId = newId()

    const result = await listingHandler(
      recorder.provider,
      fakeStorage(PNG_BYTES),
    )({
      listingId: missingId,
    })

    expect(result.status).toBe('missing')
    expect(result.sourceObjectKey).toBeNull()
    expect(recorder.calls()).toBe(0)
    expect(await findVisualEmbedding(db, missingId, 'missing-v1')).toBeNull()
  })

  test('没有 sort_order = 0 的封面 → no_cover：不调 provider、不写行', async () => {
    const listingId = await createListing()
    // 只有第 2 张图：钉住"封面 = sort_order 0"这个判据，非封面图不参与嵌入。
    await addImage(listingId, 'listings/second.png', 1)

    const recorder = recordingProvider('no-cover-v1', async () => testVector())
    const result = await listingHandler(recorder.provider, fakeStorage(PNG_BYTES))({ listingId })

    expect(result.status).toBe('no_cover')
    expect(result.sourceObjectKey).toBeNull()
    expect(recorder.calls()).toBe(0)
    expect(await findVisualEmbedding(db, listingId, 'no-cover-v1')).toBeNull()
  })

  test('首次运行 → generated：维度、向量、sourceObjectKey 与 sourceUpdatedAt 都按封面落库', async () => {
    const listingId = await createListing()
    const coverKey = 'listings/cover-a.png'
    await addImage(listingId, coverKey, 0)
    const updatedAt = await listingUpdatedAt(listingId)

    const recorder = recordingProvider('first-run-v1', async () => testVector())
    const result = await listingHandler(recorder.provider, fakeStorage(PNG_BYTES))({ listingId })

    expect(result).toEqual({
      listingId,
      status: 'generated',
      model: 'first-run-v1',
      sourceObjectKey: coverKey,
    })

    const row = await findVisualEmbedding(db, listingId, 'first-run-v1')
    expect(row?.dimensions).toBe(VISUAL_EMBEDDING_DIMENSIONS)
    expect(row?.embedding).toEqual(testVector())
    expect(row?.sourceObjectKey).toBe(coverKey)
    // source_updated_at 是写入时的 CAS 版本号，必须等于读 Listing 那一刻的 updated_at。
    expect(row?.sourceUpdatedAt.getTime()).toBe(updatedAt.getTime())
  })

  test('封面未变 → unchanged：不再调 provider，原有行的键与版本原样保留', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/cover-a.png', 0)

    const recorder = recordingProvider('unchanged-v1', async () => testVector())
    const handler = listingHandler(recorder.provider, fakeStorage(PNG_BYTES))
    expect((await handler({ listingId })).status).toBe('generated')
    const before = await findVisualEmbedding(db, listingId, 'unchanged-v1')

    expect((await handler({ listingId })).status).toBe('unchanged')
    // 键一致 ⇒ 不重复调 provider：重新嵌一张图是要花钱的。
    expect(recorder.calls()).toBe(1)
    expect(await findVisualEmbedding(db, listingId, 'unchanged-v1')).toEqual(before)
  })

  test('封面被替换 → generated：落库的是新封面键（旧向量不再对应当前封面）', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/cover-a.png', 0)

    const recorder = recordingProvider('replace-v1', async () => testVector())
    const handler = listingHandler(recorder.provider, fakeStorage(PNG_BYTES))
    expect((await handler({ listingId })).status).toBe('generated')

    // 换图 = 新对象键；真实路径上还会 bump 实体版本，这里一起推进以断言 CAS 版本跟上。
    await db
      .update(listingImages)
      .set({ objectKey: 'listings/cover-b.png' })
      .where(and(eq(listingImages.listingId, listingId), eq(listingImages.sortOrder, 0)))
    const bumpedAt = new Date(Date.now() + 1000)
    await db.update(listings).set({ updatedAt: bumpedAt }).where(eq(listings.id, listingId))

    const result = await handler({ listingId })

    expect(result.status).toBe('generated')
    expect(result.sourceObjectKey).toBe('listings/cover-b.png')
    expect(recorder.calls()).toBe(2)

    const row = await findVisualEmbedding(db, listingId, 'replace-v1')
    expect(row?.sourceObjectKey).toBe('listings/cover-b.png')
    expect(row?.sourceUpdatedAt.getTime()).toBe(bumpedAt.getTime())
  })

  test('读不到封面字节 → EmbeddingProviderError(network，可重试)：S3 抖动应交队列重试', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/cover-a.png', 0)

    const recorder = recordingProvider('read-fail-v1', async () => testVector())
    // 对象缺失或读取失败都返回 null；这里模拟"暂时读不到"。
    const error = await captureError(
      listingHandler(recorder.provider, fakeStorage(null))({ listingId }),
    )

    expectProviderError(error, 'network')
    expect((error as EmbeddingProviderError).retryable).toBe(true)
    expect(recorder.calls()).toBe(0)
    expect(await findVisualEmbedding(db, listingId, 'read-fail-v1')).toBeNull()
  })

  test('封面超过字节上限 → VisualSourceImageError：确定性失败，绝不重试', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/huge.png', 0)

    const recorder = recordingProvider('oversize-v1', async () => testVector())
    // 多 1 字节就越界；真实存储读到 maxBytes + 1 也停在这里。
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1)
    const error = await captureError(
      listingHandler(recorder.provider, fakeStorage(oversized))({ listingId }),
    )

    expect(error).toBeInstanceOf(VisualSourceImageError)
    // 不是 EmbeddingProviderError ⇒ worker 的 isFatalError 判 FATAL，不走队列重试。
    expect(error).not.toBeInstanceOf(EmbeddingProviderError)
    expect(recorder.calls()).toBe(0)
    expect(await findVisualEmbedding(db, listingId, 'oversize-v1')).toBeNull()
  })

  test('封面魔术字节不是受支持图片 → VisualSourceImageError', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/not-image.bin', 0)

    const recorder = recordingProvider('bad-magic-v1', async () => testVector())
    const notAnImage = new TextEncoder().encode('这不是图片')
    const error = await captureError(
      listingHandler(recorder.provider, fakeStorage(notAnImage))({ listingId }),
    )

    expect(error).toBeInstanceOf(VisualSourceImageError)
    expect(recorder.calls()).toBe(0)
    expect(await findVisualEmbedding(db, listingId, 'bad-magic-v1')).toBeNull()
  })

  test('provider 返回向量长度不符 → dimension_mismatch，不写行', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/cover-a.png', 0)

    // 声明维度正确、返回值错误：对应"上游悄悄改了输出维度"的现场。
    const recorder = recordingProvider('short-vector-v1', async () => [1, 2, 3])
    const error = await captureError(
      listingHandler(recorder.provider, fakeStorage(PNG_BYTES))({ listingId }),
    )

    expectProviderError(error, 'dimension_mismatch')
    expect(await findVisualEmbedding(db, listingId, 'short-vector-v1')).toBeNull()
  })

  test('provider 返回 NaN / Infinity → invalid_response，不写行', async () => {
    const listingId = await createListing()
    await addImage(listingId, 'listings/cover-a.png', 0)

    const nanVector = testVector()
    nanVector[0] = Number.NaN
    const nanRecorder = recordingProvider('nan-vector-v1', async () => nanVector)
    expectProviderError(
      await captureError(
        listingHandler(nanRecorder.provider, fakeStorage(PNG_BYTES))({ listingId }),
      ),
      'invalid_response',
    )

    const infiniteVector = testVector()
    infiniteVector[1] = Number.POSITIVE_INFINITY
    const infRecorder = recordingProvider('inf-vector-v1', async () => infiniteVector)
    expectProviderError(
      await captureError(
        listingHandler(infRecorder.provider, fakeStorage(PNG_BYTES))({ listingId }),
      ),
      'invalid_response',
    )

    // NaN 会让 cosine 变 NaN、以"分数为零"混进排序结果，所以一个字节都不许落库。
    expect(await findVisualEmbedding(db, listingId, 'nan-vector-v1')).toBeNull()
    expect(await findVisualEmbedding(db, listingId, 'inf-vector-v1')).toBeNull()
  })

  test('payload 非法 → InvalidJobPayloadError（FATAL，不重试）', async () => {
    const recorder = recordingProvider('payload-v1', async () => testVector())
    const handler = listingHandler(recorder.provider, fakeStorage(PNG_BYTES))

    for (const payload of [{ listingId: 'not-a-uuid' }, {}, null]) {
      await expect(handler(payload)).rejects.toBeInstanceOf(InvalidJobPayloadError)
    }
    expect(recorder.calls()).toBe(0)
  })

  test('embedImage 收到封面字节与按魔术字节嗅探出的 MIME', async () => {
    const pngListingId = await createListing()
    await addImage(pngListingId, 'listings/cover.png', 0)

    const pngRecorder = recordingProvider('sniff-v1', async () => testVector())
    await listingHandler(pngRecorder.provider, fakeStorage(PNG_BYTES))({ listingId: pngListingId })

    expect(pngRecorder.mime()).toBe('image/png')
    expect(pngRecorder.image()).toEqual(PNG_BYTES)

    // 客户端声明的 Content-Type 不可信：JPEG 也必须按字节判定并通过。
    const jpegListingId = await createListing()
    await addImage(jpegListingId, 'listings/cover.jpg', 0)

    const jpegRecorder = recordingProvider('sniff-v1', async () => testVector())
    await listingHandler(
      jpegRecorder.provider,
      fakeStorage(JPEG_BYTES),
    )({ listingId: jpegListingId })

    expect(jpegRecorder.mime()).toBe('image/jpeg')
    expect(jpegRecorder.image()).toEqual(JPEG_BYTES)
  })
})
