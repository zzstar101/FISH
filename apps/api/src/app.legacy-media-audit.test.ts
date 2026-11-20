import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { listingImages, listings } from '@fish/db/schema/listings'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { transactions } from '@fish/db/schema/transactions'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadMeetupTokenEnv, loadServerEnv } from '@fish/shared/env'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'
import { createSessions } from './modules/auth/session'
import { legacyMediaToken } from './modules/uploads/legacy-url'
import { createBunS3MediaStorage, type MediaStorage } from './modules/uploads/storage'

/**
 * 存量图片补审的读侧与人工复核闭环（#694 审查 P1-1 / P1-2 / P1-3）：
 *
 * - P1-1：legacy 代理按请求者判定——卖家 / 管理员 / 交易当事人可读，路人 404；
 * - P1-2：管理端按审计记录 id 列出 REVIEW、查看详情、读图片字节、放行 / 拒绝；
 * - P1-3：商品 REVIEW → 管理端批准后补审结论同步，图片立即可读；被 BLOCK 的可以恢复。
 *
 * 自建 scratch 库 + 真 MinIO（与 app.review-moderation.test.ts 同一模式）。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_legacy_media_audit_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

const ADMIN_ID = '01990000-0000-7000-8000-0000000002f1'
const SELLER_ID = '01990000-0000-7000-8000-0000000002f2'
const BUYER_ID = '01990000-0000-7000-8000-0000000002f3'
const OUTSIDER_ID = '01990000-0000-7000-8000-0000000002f4'

const pngBytes = (() => {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
})()

let seq = 0

function uuid7From(prefix: string, n: number): string {
  return `${prefix}${n.toString().padStart(12, '0')}`
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

const s3Config = (() => {
  const {
    S3_ENDPOINT,
    S3_REGION,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    S3_BUCKET,
    S3_PUBLIC_URL,
  } = process.env
  if (
    !S3_ENDPOINT ||
    !S3_REGION ||
    !S3_ACCESS_KEY_ID ||
    !S3_SECRET_ACCESS_KEY ||
    !S3_BUCKET ||
    !S3_PUBLIC_URL
  ) {
    return null
  }
  return {
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    bucket: S3_BUCKET,
    publicUrl: S3_PUBLIC_URL,
  }
})()

const s3 = s3Config
  ? new Bun.S3Client({
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
      bucket: s3Config.bucket,
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      virtualHostedStyle: process.env.S3_VIRTUAL_HOSTED_STYLE === 'true',
    })
  : null

const storage: MediaStorage | null =
  s3 && s3Config ? createBunS3MediaStorage({ client: s3, publicUrlBase: s3Config.publicUrl }) : null

/** 存储不可用时跳过「真的读字节」的用例（与 uploads/storage.test.ts 同一取舍）。 */
const storageReachable = s3
  ? await s3.exists('__reachability_probe__').then(
      () => true,
      () => false,
    )
  : false

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  await db.execute(sql`
    INSERT INTO users (id, nickname, role, auth_status, verified_at)
    VALUES (${ADMIN_ID}, '存量补审管理员', 'ADMIN', 'VERIFIED', now()),
           (${SELLER_ID}, '存量补审卖家', 'USER', 'VERIFIED', now()),
           (${BUYER_ID}, '存量补审买家', 'USER', 'VERIFIED', now()),
           (${OUTSIDER_ID}, '无关路人', 'USER', 'UNVERIFIED', NULL)
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

async function loginAs(userId: string): Promise<string> {
  const { token } = await createSessions(db).create(userId)
  return `fish_session=${token}`
}

const postAs = (cookie: string, body: unknown, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', cookie, ...extraHeaders },
  body: JSON.stringify(body),
})

interface SeededListing {
  listingId: string
  objectKey: string
  itemId: string
}

/** 一件带审核中历史图的商品 + 一条 AUDITED 补审记录（真实读侧只看审计行）。 */
async function seedListingWithAudit(input: {
  decision: 'ALLOW' | 'BLOCK' | 'REVIEW'
  moderationStatus?: 'REVIEW' | 'APPROVED'
}): Promise<SeededListing> {
  const n = seq++
  const listingId = uuid7From('01990000-0000-7e00-8000-', n)
  const listingNo = await reserveTestListingNo(db, listingId)
  await db.insert(listings).values({
    id: listingId,
    listingNo,
    sellerId: SELLER_ID,
    title: `存量图商品 ${n}`,
    description: '历史图片待补审',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
    status: 'ACTIVE',
    moderationStatus: input.moderationStatus ?? 'APPROVED',
  })

  const objectKey = `listings/${uuid7From('01990000-0000-7a00-8000-', n)}/legacy.png`
  await db.insert(listingImages).values({ listingId, objectKey, sortOrder: 0 })

  const itemId = newId()
  // jsonb 必须走 jsonParam：drizzle 直接给数组会落成 jsonb 字符串（`source_refs->0` 为 null）。
  await db.execute(sql`
    INSERT INTO legacy_media_audit_items
      (id, object_key, source_kind, source_table, source_refs, owner_user_id, public_visibility,
       audit_status, decision, provider, policy_version, suggestion, mime_type, size_bytes,
       audited_at, version)
    VALUES (
      ${itemId}::uuid, ${objectKey}, 'LISTING'::legacy_media_source_kind, 'listing_images',
      ${jsonParam([
        {
          kind: 'LISTING',
          sourceTable: 'listing_images',
          ownerUserId: SELLER_ID,
          listingId,
        },
      ])},
      ${SELLER_ID}::uuid, 'LEGACY_PROXY'::legacy_media_public_visibility,
      'AUDITED'::legacy_media_audit_status, ${input.decision}::moderation_decision, 'LOCAL',
      'test-policy',
      ${input.decision === 'ALLOW' ? 'Pass' : input.decision === 'BLOCK' ? 'Block' : 'Review'},
      'image/png', ${pngBytes.byteLength}, now(), 0
    )
  `)

  if (storage) {
    const signed = storage.presignPut({ key: objectKey, contentType: 'image/png' })
    await fetch(signed.url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: pngBytes,
    })
  }
  return { listingId, objectKey, itemId }
}

function legacyUrl(objectKey: string): string {
  const secret = loadMeetupTokenEnv().MEETUP_TOKEN_SECRET
  return `/uploads/legacy/${legacyMediaToken(objectKey, secret)}`
}

function itemPublicId(itemId: string): string {
  return encodePublicId(PUBLIC_ID_PREFIX.legacyMediaAuditItem, itemId)
}

describe('legacy 代理按请求者放行（P1-1）', () => {
  test.skipIf(!storageReachable)('卖家 / 管理员 / 交易当事人可读 REVIEW 图，路人 404', async () => {
    const seeded = await seedListingWithAudit({ decision: 'REVIEW' })
    await db.insert(transactions).values({
      id: uuid7From('01990000-0000-7c00-8000-', seq++),
      listingId: seeded.listingId,
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      amountCents: 100,
      status: 'COMPLETED',
      completedAt: new Date(),
    })

    const url = legacyUrl(seeded.objectKey)
    for (const userId of [SELLER_ID, ADMIN_ID, BUYER_ID]) {
      const res = await app.request(url, { headers: { cookie: await loginAs(userId) } })
      expect(res.status).toBe(200)
      // 授权读不经公开缓存，避免把「给当事人的临时放行」缓存成公开内容。
      expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    }

    const outsider = await app.request(url, { headers: { cookie: await loginAs(OUTSIDER_ID) } })
    expect(outsider.status).toBe(404)

    const anonymous = await app.request(url)
    expect(anonymous.status).toBe(404)
  })
})

describe('管理端补审队列与字节（P1-2）', () => {
  test.skipIf(!storageReachable)(
    '队列只列 REVIEW，不暴露 objectKey；详情与媒体按 audit id 读取',
    async () => {
      const listing = await seedListingWithAudit({ decision: 'REVIEW' })
      const blocked = await seedListingWithAudit({ decision: 'BLOCK' })
      // 非 LISTING 来源：评价图（没有商品上下文，队列仍需能处理）。
      const reviewItemId = newId()
      const reviewKey = `reviews/${uuid7From('01990000-0000-7d00-8000-', seq++)}/photo.png`
      await db.execute(sql`
      INSERT INTO legacy_media_audit_items
        (id, object_key, source_kind, source_table, source_refs, owner_user_id, public_visibility,
         audit_status, decision, provider, policy_version, suggestion, mime_type, size_bytes,
         audited_at, version)
      VALUES (
        ${reviewItemId}::uuid, ${reviewKey}, 'REVIEW'::legacy_media_source_kind,
        'transaction_review_images',
        ${jsonParam([
          {
            kind: 'REVIEW',
            sourceTable: 'transaction_review_images',
            ownerUserId: BUYER_ID,
            reviewId: newId(),
            transactionId: newId(),
          },
        ])},
        ${BUYER_ID}::uuid, 'PRIVATE_PROXY'::legacy_media_public_visibility,
        'AUDITED'::legacy_media_audit_status, 'REVIEW'::moderation_decision, 'LOCAL',
        'test-policy', 'Review', 'image/png', ${pngBytes.byteLength}, now(), 0
      )
    `)
      if (storage) {
        const signed = storage.presignPut({ key: reviewKey, contentType: 'image/png' })
        await fetch(signed.url, {
          method: 'PUT',
          headers: { 'content-type': 'image/png' },
          body: pngBytes,
        })
      }

      const queue = await app.request('/admin/legacy-media/audit?limit=50', {
        headers: { cookie: await loginAs(ADMIN_ID) },
      })
      expect(queue.status).toBe(200)
      const body = (await queue.json()) as {
        items: {
          id: string
          sourceKind: string
          listing: { id: string; title: string } | null
          media: { contentType: string | null; sizeBytes: number | null }
        }[]
        nextCursor: string | null
      }
      const ids = body.items.map((item) => item.id)
      expect(ids).toContain(itemPublicId(listing.itemId))
      expect(ids).toContain(itemPublicId(reviewItemId))
      expect(ids).not.toContain(itemPublicId(blocked.itemId))

      const reviewItem = body.items.find((item) => item.id === itemPublicId(reviewItemId))
      expect(reviewItem?.sourceKind).toBe('REVIEW')
      expect(reviewItem?.listing).toBeNull()
      const listingItem = body.items.find((item) => item.id === itemPublicId(listing.itemId))
      expect(listingItem?.listing?.id).toBeTruthy()
      expect(JSON.stringify(body)).not.toContain('listings/')
      expect(JSON.stringify(body)).not.toContain('reviews/')

      expect((await app.request('/admin/legacy-media/audit')).status).toBe(401)
      expect(
        (
          await app.request('/admin/legacy-media/audit', {
            headers: { cookie: await loginAs(BUYER_ID) },
          })
        ).status,
      ).toBe(403)

      const detail = await app.request(
        `/admin/legacy-media/audit/${itemPublicId(listing.itemId)}`,
        {
          headers: { cookie: await loginAs(ADMIN_ID) },
        },
      )
      expect(detail.status).toBe(200)
      expect(((await detail.json()) as { media: { contentType: string } }).media.contentType).toBe(
        'image/png',
      )

      const media = await app.request(
        `/admin/legacy-media/audit/${itemPublicId(listing.itemId)}/media`,
        { headers: { cookie: await loginAs(ADMIN_ID) } },
      )
      expect(media.status).toBe(200)
      expect(media.headers.get('Cache-Control')).toBe('private, no-store')
      expect(new Uint8Array(await media.arrayBuffer())).toEqual(pngBytes)
    },
  )

  test('版本 CAS：过期版本 409，正确版本放行；重复提交幂等且写审计', async () => {
    const seeded = await seedListingWithAudit({ decision: 'REVIEW' })
    const path = `/admin/legacy-media/audit/${itemPublicId(seeded.itemId)}/decision`
    const adminCookie = await loginAs(ADMIN_ID)

    const stale = await app.request(
      path,
      postAs(adminCookie, {
        decision: 'ALLOW',
        reason: '人工复核通过',
        version: 9,
      }),
    )
    expect(stale.status).toBe(409)

    const applied = await app.request(
      path,
      postAs(adminCookie, {
        decision: 'ALLOW',
        reason: '人工复核通过',
        version: 0,
      }),
    )
    expect(applied.status).toBe(200)
    expect((await applied.json()) as unknown).toMatchObject({
      id: itemPublicId(seeded.itemId),
      decision: 'ALLOW',
      replayed: false,
      version: 1,
    })

    const replay = await app.request(
      path,
      postAs(adminCookie, {
        decision: 'ALLOW',
        reason: '人工复核通过',
        version: 0,
      }),
    )
    expect((await replay.json()) as unknown).toMatchObject({ replayed: true, version: 1 })

    const logs = rowsOf(
      await db.execute(sql`
        SELECT action, target_type, target_id, reason
        FROM admin_audit_logs
        WHERE target_type = 'LEGACY_MEDIA_AUDIT_ITEM' AND target_id = ${seeded.itemId}::uuid
      `),
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      action: 'LEGACY_MEDIA_AUDIT_DECISION',
      target_type: 'LEGACY_MEDIA_AUDIT_ITEM',
      reason: '人工复核通过',
    })

    const row = rowsOf(
      await db.execute(sql`
        SELECT decision, version FROM legacy_media_audit_items WHERE id = ${seeded.itemId}::uuid
      `),
    )[0]
    expect(row).toMatchObject({ decision: 'ALLOW', version: 1 })
  })
})

describe('审计结论可恢复（P1-3）', () => {
  test.skipIf(!storageReachable)('商品 REVIEW → 管理端批准 → 图片可读', async () => {
    const seeded = await seedListingWithAudit({ decision: 'REVIEW', moderationStatus: 'REVIEW' })
    const recordId = newId()
    await db.insert(listingModerationRecords).values({
      id: recordId,
      listingId: seeded.listingId,
      sellerId: SELLER_ID,
      action: 'UPDATE',
      titleSnapshot: '存量图商品',
      descriptionSnapshot: '历史图片待补审',
      decision: 'REVIEW',
      matchedRules: [],
      matchedTermsMasked: [],
      ruleVersion: 'test-policy',
      priorListingStatus: 'ACTIVE',
    })

    const res = await app.request(
      `/admin/moderation/${encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, recordId)}/decision`,
      postAs(
        await loginAs(ADMIN_ID),
        { decision: 'ALLOW', reason: '图片人工复核通过' },
        { 'Idempotency-Key': 'legacy-media-approve-1' },
      ),
    )
    expect(res.status).toBe(200)

    const audit = rowsOf(
      await db.execute(sql`
        SELECT decision, version FROM legacy_media_audit_items WHERE id = ${seeded.itemId}::uuid
      `),
    )[0]
    expect(audit).toMatchObject({ decision: 'ALLOW', version: 1 })

    // 商品批准后读侧立刻生效：匿名也能读到这张历史图。
    const anonymous = await app.request(legacyUrl(seeded.objectKey))
    expect(anonymous.status).toBe(200)
    expect(anonymous.headers.get('Cache-Control')).toBe('public, max-age=86400')
  })

  test.skipIf(!storageReachable)('被人工 BLOCK 的图片可从补审队列恢复', async () => {
    const seeded = await seedListingWithAudit({ decision: 'BLOCK' })
    const adminCookie = await loginAs(ADMIN_ID)

    // BLOCK 不在待审队列里，但详情 / 媒体仍可按 id 找到，才能恢复。
    const queue = await app.request('/admin/legacy-media/audit?limit=50', {
      headers: { cookie: adminCookie },
    })
    const queueBody = (await queue.json()) as { items: { id: string }[] }
    expect(queueBody.items.map((item) => item.id)).not.toContain(itemPublicId(seeded.itemId))

    expect(
      (
        await app.request(`/admin/legacy-media/audit/${itemPublicId(seeded.itemId)}`, {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(200)

    const restored = await app.request(
      `/admin/legacy-media/audit/${itemPublicId(seeded.itemId)}/decision`,
      postAs(adminCookie, { decision: 'ALLOW', reason: '误判恢复', version: 0 }),
    )
    expect(restored.status).toBe(200)
    expect((await restored.json()) as unknown).toMatchObject({ decision: 'ALLOW', version: 1 })

    const anonymous = await app.request(legacyUrl(seeded.objectKey))
    expect(anonymous.status).toBe(200)
  })
})
