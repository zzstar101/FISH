import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'
import { createSessions } from './modules/auth/session'

/**
 * 管理端交易评价图片待审闭环（#694 M5c 第三部分）：真实链路产出的 REVIEW 图片 →
 * 作者可见/他人不可见 → 管理员队列与图片字节 → 版本冲突 → 放行/拒绝 → 审计与幂等。
 *
 * 自建 scratch 库，真库 + 真 MinIO（confirm 的 presign → PUT 走同一条存储链路）。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_review_moderation_test_${process.pid}`
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

const ADMIN_ID = '01990000-0000-7000-8000-0000000000f1'
const BUYER_ID = '01990000-0000-7000-8000-0000000000f2'
const SELLER_ID = '01990000-0000-7000-8000-0000000000f3'

let seq = 0

const pngBytes = (() => {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
})()

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
  await db.execute(sql`
    INSERT INTO users (id, nickname, role, auth_status, verified_at)
    VALUES (${ADMIN_ID}, '评价图片审核员', 'ADMIN', 'VERIFIED', now()),
           (${BUYER_ID}, '评价作者', 'USER', 'UNVERIFIED', NULL),
           (${SELLER_ID}, '评价对象卖家', 'USER', 'UNVERIFIED', NULL)
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

const postAs = (cookie: string, body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})

/** 一条 COMPLETED 交易 + 会话；每个用例自己的一件商品（listing_id_live_uq 限制）。 */
async function createTransaction(): Promise<{ publicId: string; rawId: string }> {
  const n = seq++
  const listingId = `01990000-0000-7e00-8000-${n.toString().padStart(12, '0')}`
  const listingNo = await reserveTestListingNo(db, listingId)
  await db.execute(sql`
    INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${listingId}, ${listingNo}, ${SELLER_ID}, '待审图片商品', '用于评价图片审核测试', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
  await db.execute(sql`
    INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
    VALUES (${newId()}, ${listingId}, ${BUYER_ID}, ${SELLER_ID})
  `)
  const txnId = `01990000-0000-7d00-8000-${n.toString().padStart(12, '0')}`
  await db.execute(sql`
    INSERT INTO transactions (id, listing_id, buyer_id, seller_id, amount_cents, status,
      buyer_confirmed_at, seller_confirmed_at, completed_at)
    VALUES (${txnId}, ${listingId}, ${BUYER_ID}, ${SELLER_ID}, 16000, 'COMPLETED', now(), now(), now())
  `)
  return { publicId: encodePublicId(PUBLIC_ID_PREFIX.transaction, txnId), rawId: txnId }
}

/** presign → 直传 MinIO → confirm；local transport 下图片结论恒 REVIEW。 */
async function uploadPendingImage(
  cookie: string,
  transactionPublicId: string,
): Promise<{ objectKey: string; moderationDecision: string }> {
  const presignRes = await app.request(
    `/transactions/${transactionPublicId}/review/media/presign`,
    postAs(cookie, { contentType: 'image/png', sizeBytes: pngBytes.byteLength }),
  )
  expect(presignRes.status).toBe(200)
  const presign = (await presignRes.json()) as { uploadUrl: string; objectKey: string }
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: pngBytes,
  })
  expect(put.status).toBe(200)
  const confirmRes = await app.request(
    `/transactions/${transactionPublicId}/review/media/confirm`,
    postAs(cookie, { objectKey: presign.objectKey }),
  )
  expect(confirmRes.status).toBe(200)
  return (await confirmRes.json()) as { objectKey: string; moderationDecision: string }
}

async function createReviewWithPendingImage(
  cookie: string,
  transactionPublicId: string,
): Promise<{ privateKey: string; reviewEdge: string }> {
  const image = await uploadPendingImage(cookie, transactionPublicId)
  expect(image.objectKey).toMatch(/^review-moderation-media\/usr_[0-9a-z]+\/med_[0-9a-z]+\.png$/)
  expect(image.moderationDecision).toBe('REVIEW')
  const reviewEdge = `/transactions/${transactionPublicId}/review`
  const created = await app.request(
    reviewEdge,
    postAs(cookie, {
      rating: 'POSITIVE',
      body: '这件商品不错，附一张图',
      imageObjectKeys: [image.objectKey],
    }),
  )
  expect(created.status).toBe(201)
  return { privateKey: image.objectKey, reviewEdge }
}

interface QueueBody {
  items: {
    id: string
    author: { id: string; nickname: string }
    transaction: { id: string; listing: { id: string; title: string } }
    review: { body: string | null } | null
    image: { contentType: string; sizeBytes: number }
    decision: string
    provider: string
    suggestion: string | null
    version: number
  }[]
  nextCursor: string | null
}

describe('管理端交易评价图片待审（#694 M5c）', () => {
  let adminCookie: string
  let buyerCookie: string
  let sellerCookie: string
  let queuePath: string
  let transactionPublicId: string
  let privateKey: string
  let reviewEdge: string
  let recordId: string

  test('setup: 登录与待审图片评价', async () => {
    adminCookie = await loginAs(ADMIN_ID)
    buyerCookie = await loginAs(BUYER_ID)
    sellerCookie = await loginAs(SELLER_ID)
    const txn = await createTransaction()
    transactionPublicId = txn.publicId
    const created = await createReviewWithPendingImage(buyerCookie, transactionPublicId)
    privateKey = created.privateKey
    reviewEdge = created.reviewEdge
    queuePath = '/admin/reviews/moderation'
  })

  test('匿名 401、普通用户 403，队列/决策/媒体都不放行', async () => {
    expect((await app.request(queuePath)).status).toBe(401)
    expect((await app.request(queuePath, { headers: { cookie: buyerCookie } })).status).toBe(403)

    const fakeId = encodePublicId(
      PUBLIC_ID_PREFIX.reviewModerationRecord,
      '01990000-0000-7000-8000-0000000000fa',
    )
    const decision = await app.request(
      `${queuePath}/${fakeId}/decision`,
      postAs(buyerCookie, { decision: 'ALLOW', reason: '越权', version: 0 }),
    )
    expect(decision.status).toBe(403)
    expect(
      (
        await app.request(`${queuePath}/${fakeId}/media`, {
          headers: { cookie: buyerCookie },
        })
      ).status,
    ).toBe(403)
  })

  test('作者看到待审图片；其他参与者看不到整条评价；私有对象不匿名可读', async () => {
    const mine = await app.request(reviewEdge, { headers: { cookie: buyerCookie } })
    expect(mine.status).toBe(200)
    const mineBody = (await mine.json()) as {
      images: { moderationDecision?: string }[]
    }
    expect(mineBody.images.map((image) => image.moderationDecision)).toEqual(['REVIEW'])

    const sellerList = await app.request(`/transactions/${transactionPublicId}/reviews`, {
      headers: { cookie: sellerCookie },
    })
    expect(sellerList.status).toBe(200)
    expect(((await sellerList.json()) as { items: unknown[] }).items).toHaveLength(0)

    const anonymousRead = await fetch(`http://localhost:9000/fish/${privateKey}`)
    expect(anonymousRead.status).toBe(403)
  })

  test('队列含作者/交易/评价/图片元数据，图片字节仅管理员可读且 private/no-store', async () => {
    const res = await app.request(queuePath, { headers: { cookie: adminCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as QueueBody
    expect(body.items).toHaveLength(1)
    const item = body.items[0]
    if (!item) throw new Error('队列为空')
    recordId = item.id
    expect(item.author.nickname).toBe('评价作者')
    expect(item.transaction.listing.title).toBe('待审图片商品')
    expect(item.review?.body).toBe('这件商品不错，附一张图')
    expect(item.image).toEqual({ contentType: 'image/png', sizeBytes: pngBytes.byteLength })
    expect(item.decision).toBe('REVIEW')
    expect(item.provider).toBe('LOCAL')
    expect(item.suggestion).toBe('Review')
    expect(item.version).toBe(0)

    const media = await app.request(`${queuePath}/${recordId}/media`, {
      headers: { cookie: adminCookie },
    })
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/png')
    expect(media.headers.get('cache-control')).toBe('private, no-store')
    expect(media.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(pngBytes)
  })

  test('版本冲突先于放行；放行后图片转公开、评价恢复公开、审计落库、重放幂等', async () => {
    const stale = await app.request(
      `${queuePath}/${recordId}/decision`,
      postAs(adminCookie, { decision: 'ALLOW', reason: '放行', version: 99 }),
    )
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'REVIEW_MODERATION_CONFLICT',
    )

    const allowed = await app.request(
      `${queuePath}/${recordId}/decision`,
      postAs(adminCookie, { decision: 'ALLOW', reason: '图片正常，放行', version: 0 }),
    )
    expect(allowed.status).toBe(200)
    expect((await allowed.json()) as object).toEqual({
      id: recordId,
      decision: 'ALLOW',
      replayed: false,
    })

    const replay = await app.request(
      `${queuePath}/${recordId}/decision`,
      postAs(adminCookie, { decision: 'ALLOW', reason: '重复提交', version: 0 }),
    )
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { replayed: boolean }).replayed).toBe(true)

    const sellerList = await app.request(`/transactions/${transactionPublicId}/reviews`, {
      headers: { cookie: sellerCookie },
    })
    expect(sellerList.status).toBe(200)
    const sellerBody = (await sellerList.json()) as {
      items: { review: { images: { url: string; moderationDecision?: string }[] } }[]
    }
    expect(sellerBody.items).toHaveLength(1)
    const images = sellerBody.items[0]?.review.images ?? []
    expect(images.map((image) => image.moderationDecision)).toEqual(['ALLOW'])
    expect(images[0]?.url).toContain('/api/uploads/media/')
    expect(images[0]?.url).not.toContain(privateKey)

    const recordRows = (await db.execute(sql`
      SELECT settled_decision, final_key, version, reviewed_by
      FROM review_moderation_records WHERE id = ${decodePublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, recordId)}::uuid
    `)) as
      | {
          rows: {
            settled_decision: string
            final_key: string
            version: number
            reviewed_by: string
          }[]
        }
      | { settled_decision: string; final_key: string; version: number; reviewed_by: string }[]
    const record = Array.isArray(recordRows) ? recordRows[0] : recordRows.rows[0]
    expect(record?.settled_decision).toBe('ALLOW')
    expect(record?.final_key).toMatch(/^reviews\/usr_[0-9a-z]+\/med_[0-9a-z]+\.png$/)
    expect(record?.version).toBe(1)
    expect(record?.reviewed_by).toBe(ADMIN_ID)

    const imageRows = (await db.execute(sql`
      SELECT object_key FROM transaction_review_images WHERE object_key = ${record?.final_key ?? ''}
    `)) as { rows?: { object_key: string }[] } | { object_key: string }[]
    const imageRowList = Array.isArray(imageRows) ? imageRows : (imageRows.rows ?? [])
    expect(imageRowList).toHaveLength(1)

    const audits = (await db.execute(sql`
      SELECT action, target_type, target_id FROM admin_audit_logs
      WHERE target_id = ${decodePublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, recordId)}::uuid
    `)) as
      | { rows: { action: string; target_type: string; target_id: string }[] }
      | { action: string; target_type: string; target_id: string }[]
    const auditRows = Array.isArray(audits) ? audits : audits.rows
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]).toMatchObject({
      action: 'REVIEW_MODERATION_DECISION',
      target_type: 'REVIEW_MODERATION_RECORD',
    })

    const queueAfter = await app.request(queuePath, { headers: { cookie: adminCookie } })
    expect(((await queueAfter.json()) as QueueBody).items).toHaveLength(0)
  })

  test('拒绝：作者侧图片消失、对方仍看不到评价、不产生公开键、审计记录拒绝', async () => {
    const txn = await createTransaction()
    const created = await createReviewWithPendingImage(buyerCookie, txn.publicId)

    const queue = await app.request(queuePath, { headers: { cookie: adminCookie } })
    const item = ((await queue.json()) as QueueBody).items[0]
    if (!item) throw new Error('队列为空')

    const blocked = await app.request(
      `${queuePath}/${item.id}/decision`,
      postAs(adminCookie, { decision: 'BLOCK', reason: '图片不合适', version: 0 }),
    )
    expect(blocked.status).toBe(200)
    expect(((await blocked.json()) as { decision: string }).decision).toBe('BLOCK')

    const mine = await app.request(created.reviewEdge, { headers: { cookie: buyerCookie } })
    expect(mine.status).toBe(200)
    expect(((await mine.json()) as { images: unknown[] }).images).toHaveLength(0)

    const sellerList = await app.request(`/transactions/${txn.publicId}/reviews`, {
      headers: { cookie: sellerCookie },
    })
    expect(((await sellerList.json()) as { items: unknown[] }).items).toHaveLength(0)

    const recordRows = (await db.execute(sql`
      SELECT settled_decision, final_key FROM review_moderation_records WHERE id = ${decodePublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, item.id)}::uuid
    `)) as
      | { rows: { settled_decision: string; final_key: string }[] }
      | {
          settled_decision: string
          final_key: string
        }[]
    const record = Array.isArray(recordRows) ? recordRows[0] : recordRows.rows[0]
    expect(record?.settled_decision).toBe('BLOCK')
    expect(record?.final_key).toBe(created.privateKey)
    expect(record?.final_key.startsWith('reviews/')).toBe(false)
  })

  test('放行前重读私有字节：台账摘要与对象不一致 → 409，不结算', async () => {
    const txn = await createTransaction()
    await createReviewWithPendingImage(buyerCookie, txn.publicId)

    const queue = await app.request(queuePath, { headers: { cookie: adminCookie } })
    const item = ((await queue.json()) as QueueBody).items[0]
    if (!item) throw new Error('队列为空')

    const recordId = decodePublicId(PUBLIC_ID_PREFIX.reviewModerationRecord, item.id)
    await db.execute(sql`
      UPDATE review_moderation_records SET content_digest = ${'0'.repeat(64)} WHERE id = ${recordId}::uuid
    `)

    const tampered = await app.request(
      `${queuePath}/${item.id}/decision`,
      postAs(adminCookie, { decision: 'ALLOW', reason: '尝试放行', version: 0 }),
    )
    expect(tampered.status).toBe(409)
    const body = (await tampered.json()) as { error: { code: string } }
    expect(body.error.code).toBe('REVIEW_MODERATION_CONFLICT')

    const rows = (await db.execute(sql`
      SELECT settled_decision, final_key FROM review_moderation_records WHERE id = ${recordId}::uuid
    `)) as
      | { rows: { settled_decision: string | null; final_key: string }[] }
      | { settled_decision: string | null; final_key: string }[]
    const record = Array.isArray(rows) ? rows[0] : rows.rows[0]
    expect(record?.settled_decision).toBeNull()
    expect(record?.final_key.startsWith('review-moderation-media/')).toBe(true)
  })
})
