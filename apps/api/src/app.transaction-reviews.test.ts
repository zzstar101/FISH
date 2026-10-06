import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** 与 app.wishes.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_reviews_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

const sellerId = '01990000-0000-7000-8000-0000000000e9'
/** 卖家是 beforeAll 直插的用户（不注册），评价行按「双方各一条」约束直插。 */
const SELLER_STUDENT_NO = `2026${String(process.pid % 10000).padStart(4, '0')}9999`

let seq = 0

/**
 * 每个用例**自己的一件商品**：transactions 的 `listing_id_live_uq` 是「每件商品至多一笔
 * 未取消交易」，共用一件商品会让第二个用例的成交行撞索引。
 */
async function createListing(): Promise<{ rawId: string; publicId: string }> {
  const rawId = `01990000-0000-7e00-8000-${(seq++).toString().padStart(12, '0')}`
  const listingNo = await reserveTestListingNo(db, rawId)
  await db.execute(sql`
    INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${rawId}, ${listingNo}, ${sellerId}, '商品', '描述', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
  return { rawId, publicId: encodePublicId(PUBLIC_ID_PREFIX.listing, rawId) }
}
beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  await db.execute(sql`
    INSERT INTO users (id, student_no, password_hash, nickname)
    VALUES (${sellerId}, ${SELLER_STUDENT_NO}, 'test-hash', '评价验收卖家')
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

/** 走真实注册拿会话 cookie：证明的是 app 级接线，而不是 router 的单测。 */
async function signUp(): Promise<string> {
  const studentNo = `2026${String(process.pid % 10000).padStart(4, '0')}${String(seq++).padStart(4, '0')}`
  const response = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentNo, password: 'fish123456', nickname: '评价验收买家' }),
  })
  expect(response.status).toBe(200)
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

function json(body: unknown, cookie?: string) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }
}

function get(cookie?: string): RequestInit {
  return { headers: cookie ? { cookie } : {} }
}

async function buyerIdOf(cookie: string): Promise<string> {
  const me = await app.request('/me', { headers: { cookie } })
  const body = (await me.json()) as { user?: { id?: string } }
  const publicId = body.user?.id
  if (!publicId) throw new Error('注册后取不到本人 id')
  const result = (await db.execute(sql`SELECT id FROM users`)) as
    | { rows: { id: string }[] }
    | { id: string }[]
  const rows = Array.isArray(result) ? result : result.rows
  for (const row of rows) {
    if (encodePublicId(PUBLIC_ID_PREFIX.user, row.id) === publicId) return row.id
  }
  throw new Error('本人 id 不在用户表里')
}

/**
 * 一条独立交易 + 对应会话（评价时间线的订单 DTO 要 join conversation）。
 * 返回公开与原始两种 id。
 */
async function createTransaction(
  buyerId: string,
  listing: { rawId: string },
  overrides: { status?: 'COMPLETED' | 'PENDING_MEETUP' } = {},
): Promise<{ publicId: string; rawId: string }> {
  const status = overrides.status ?? 'COMPLETED'
  const n = seq++
  const txnRawId = `01990000-0000-7d00-8000-${n.toString().padStart(12, '0')}`
  await db.execute(sql`
    INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
    VALUES (${newId()}, ${listing.rawId}, ${buyerId}, ${sellerId})
  `)
  await db.execute(sql`
    INSERT INTO transactions (id, listing_id, buyer_id, seller_id, amount_cents, status,
      buyer_confirmed_at, seller_confirmed_at, completed_at)
    VALUES (${txnRawId}, ${listing.rawId}, ${buyerId}, ${sellerId}, 16000, ${status},
      ${status === 'COMPLETED' ? sql`now()` : sql`NULL`},
      ${status === 'COMPLETED' ? sql`now()` : sql`NULL`},
      ${status === 'COMPLETED' ? sql`now()` : sql`NULL`})
  `)
  return {
    publicId: encodePublicId(PUBLIC_ID_PREFIX.transaction, txnRawId),
    rawId: txnRawId,
  }
}

const error = (body: unknown) => (body as { error: { code: string } }).error.code

describe('交易评价 app 级接线（#195 PR2）', () => {
  test('匿名全部 401（本域没有匿名路径）', async () => {
    const txnPublic = encodePublicId(
      PUBLIC_ID_PREFIX.transaction,
      '01990000-0000-7000-8000-0000000000a9',
    )
    for (const [method, path, body] of [
      ['GET', `/transactions/${txnPublic}/review`, undefined],
      ['POST', `/transactions/${txnPublic}/review`, JSON.stringify({ rating: 'POSITIVE' })],
      ['DELETE', `/transactions/${txnPublic}/review`, undefined],
      ['GET', `/transactions/${txnPublic}/reviews`, undefined],
      // #475：两条媒体端点同样没有匿名路径（app.ts 为它们显式补挂了 requireAuth，接线易漏）。
      ['POST', `/transactions/${txnPublic}/review/media/presign`, JSON.stringify({})],
      ['POST', `/transactions/${txnPublic}/review/media/confirm`, JSON.stringify({})],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(401)
    }
  })

  test('完整闭环：非参与者 404 → 未完成 409 → 评一条 201 → 重复 409 → 两方对账 → 删除幂等', async () => {
    const buyerCookie = await signUp()
    const buyerId = await buyerIdOf(buyerCookie)
    const txn = await createTransaction(buyerId, await createListing())
    const edge = `/transactions/${txn.publicId}/review`

    // 非参与者与不存在同码 404
    const outsider = await signUp()
    const outsiderRes = await app.request(edge, get(outsider))
    expect(outsiderRes.status).toBe(404)
    expect(error(await outsiderRes.json())).toBe('TRANSACTION_NOT_FOUND')

    // 未完成交易 409
    const pending = await createTransaction(buyerId, await createListing(), {
      status: 'PENDING_MEETUP',
    })
    const pendingRes = await app.request(
      `/transactions/${pending.publicId}/review`,
      json({ rating: 'POSITIVE' }, buyerCookie),
    )
    expect(pendingRes.status).toBe(409)
    expect(error(await pendingRes.json())).toBe('TRANSACTION_NOT_COMPLETED')

    // 买家评一条（201）；body 缺省合法（只打分不写字）
    const created = await app.request(edge, json({ rating: 'POSITIVE' }, buyerCookie))
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      id: string
      transactionId: string
      rating: string
      body: string | null
      images: unknown[]
    }
    expect(createdBody.rating).toBe('POSITIVE')
    expect(createdBody.transactionId).toBe(txn.publicId)
    expect(createdBody.body).toBeNull()
    expect(createdBody.id.startsWith('rvw_')).toBe(true)

    // 重复评价 409（各方一条）
    const duplicate = await app.request(edge, json({ rating: 'NEGATIVE' }, buyerCookie))
    expect(duplicate.status).toBe(409)
    expect(error(await duplicate.json())).toBe('TRANSACTION_REVIEW_EXISTS')

    // 卖家评同一笔交易（各一条）：直插（卖家没有注册会话），约束与写接口同一把唯一索引兜底
    await db.execute(sql`
      INSERT INTO transaction_reviews (id, transaction_id, author_id, rating, body)
      VALUES (${newId()}, ${txn.rawId}::uuid, ${sellerId}::uuid, 'NEUTRAL', '合作顺利')
    `)

    // 两方对账：参与者可见两行（buyer / seller 各一），非参与者 404
    const bothRes = await app.request(`/transactions/${txn.publicId}/reviews`, get(buyerCookie))
    expect(bothRes.status).toBe(200)
    const both = (await bothRes.json()) as {
      items: { authorRole: string; review: { rating: string } }[]
    }
    expect(both.items.length).toBe(2)
    expect(both.items.map((item) => item.authorRole).sort()).toEqual(['buyer', 'seller'])
    const outsiderBoth = await app.request(`/transactions/${txn.publicId}/reviews`, get(outsider))
    expect(outsiderBoth.status).toBe(404)

    // GET 我的评价边
    const myRes = await app.request(edge, get(buyerCookie))
    expect(myRes.status).toBe(200)
    expect(((await myRes.json()) as { rating: string }).rating).toBe('POSITIVE')

    // 删除幂等：第一次 {deleted:1}，第二次 {deleted:0}
    const del1 = await app.request(edge, { method: 'DELETE', headers: { cookie: buyerCookie } })
    expect(del1.status).toBe(200)
    expect(await del1.json()).toEqual({ deleted: 1 })
    const del2 = await app.request(edge, { method: 'DELETE', headers: { cookie: buyerCookie } })
    expect(del2.status).toBe(200)
    expect(await del2.json()).toEqual({ deleted: 0 })
  })

  test('/me/comments 三档：kind=review 进时间线、kind=comment 不混入、kind=all 合并且游标带来源', async () => {
    const buyerCookie = await signUp()
    const buyerId = await buyerIdOf(buyerCookie)
    const listing = await createListing()
    const txn = await createTransaction(buyerId, listing)
    const created = await app.request(
      `/transactions/${txn.publicId}/review`,
      json({ rating: 'NEGATIVE', body: '迟到半小时' }, buyerCookie),
    )
    expect(created.status).toBe(201)

    // 发一条留言（真实写接口），供 kind=all 合并
    const comment = await app.request(
      `/listings/${listing.publicId}/comments`,
      json({ content: '留言一条，用于合并时间线' }, buyerCookie),
    )
    expect(comment.status).toBe(201)

    // kind=review：一行，内嵌真实订单 DTO（transactionId / role=buyer）
    const reviewsRes = await app.request('/me/comments?kind=review', get(buyerCookie))
    expect(reviewsRes.status).toBe(200)
    const reviewsBody = (await reviewsRes.json()) as {
      items: { review: { rating: string }; transaction: { id: string; role: string } }[]
      total: number
    }
    expect(reviewsBody.total).toBe(1)
    expect(reviewsBody.items[0]?.review.rating).toBe('NEGATIVE')
    expect(reviewsBody.items[0]?.transaction.id).toBe(txn.publicId)
    expect(reviewsBody.items[0]?.transaction.role).toBe('buyer')

    // 默认（kind=comment）：评价不混入（PR1 行为不变）
    const commentRes = await app.request('/me/comments', get(buyerCookie))
    const commentBody = (await commentRes.json()) as {
      items: { comment: unknown }[]
      total: number
    }
    expect(commentBody.total).toBe(1)
    expect(commentBody.items.length).toBe(1)
    expect(commentBody.items[0]?.comment).toBeDefined()

    // kind=all：total = 留言 + 评价，两类行都在
    const allRes = await app.request('/me/comments?kind=all&limit=50', get(buyerCookie))
    const allBody = (await allRes.json()) as {
      items: { comment?: unknown; review?: unknown }[]
      total: number
      nextCursor: string | null
    }
    expect(allBody.total).toBe(2)
    expect(allBody.items.some((item) => item.comment !== undefined)).toBe(true)
    expect(allBody.items.some((item) => item.review !== undefined)).toBe(true)
    expect(allBody.nextCursor).toBeNull()

    // limit=1 翻页：两页合起来不重不漏，游标里的 source 与行来源一致
    const page1Res = await app.request('/me/comments?kind=all&limit=1', get(buyerCookie))
    const page1 = (await page1Res.json()) as {
      items: { comment?: unknown; review?: unknown }[]
      nextCursor: string | null
    }
    expect(page1.items.length).toBe(1)
    expect(page1.nextCursor).not.toBeNull()
    const cursorPayload = JSON.parse(
      Buffer.from(page1.nextCursor ?? '', 'base64url').toString('utf8'),
    ) as { source: string }
    const firstIsComment = page1.items[0]?.comment !== undefined
    expect(cursorPayload.source).toBe(firstIsComment ? 'comment' : 'review')

    const page2Res = await app.request(
      `/me/comments?kind=all&limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
      get(buyerCookie),
    )
    const page2 = (await page2Res.json()) as {
      items: { comment?: unknown; review?: unknown }[]
      nextCursor: string | null
    }
    expect(page2.items.length).toBe(1)
    expect(page2.nextCursor).toBeNull()
    // 第二页的行类型必须与第一页不同（留言 1 + 评价 1）
    expect(page2.items[0]?.comment !== undefined).toBe(!firstIsComment)

    // 拿评价游标翻留言页 → 422（错表 seek 宁可报错不静默错乱）
    const reviewCursorRes = await app.request('/me/comments?kind=review&limit=1', get(buyerCookie))
    const reviewBody = (await reviewCursorRes.json()) as { nextCursor: string | null }
    // 只有 >1 条评价才有评价游标；本用例单条，构造一个评价源游标验证 kind 校验
    if (reviewBody.nextCursor === null) {
      const fakeReviewCursor = Buffer.from(
        JSON.stringify({
          createdAt: '2026-10-01T12:00:00.000000Z',
          id: 'rvw_01930000-0000-7000-8000-0000000000b1',
          source: 'review',
        }),
        'utf8',
      ).toString('base64url')
      const wrong = await app.request(
        `/me/comments?kind=comment&cursor=${encodeURIComponent(fakeReviewCursor)}`,
        get(buyerCookie),
      )
      expect(wrong.status).toBe(422)
    }
  })
})

describe('#475 评价配图上传链 app 级接线', () => {
  /** 64 字节 PNG（魔数正确即可——本链不做尺寸解析，内容层面只验魔数与声明一致）。 */
  const pngBytes = (() => {
    const bytes = new Uint8Array(64)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    return bytes
  })()

  async function uploadImage(cookie: string, txnPublicId: string): Promise<string> {
    const presignRes = await app.request(
      `/transactions/${txnPublicId}/review/media/presign`,
      json({ contentType: 'image/png', sizeBytes: pngBytes.byteLength }, cookie),
    )
    expect(presignRes.status).toBe(200)
    const presign = (await presignRes.json()) as { uploadUrl: string; objectKey: string }
    expect(presign.objectKey).toMatch(
      /^transaction-review-media\/usr_[0-9a-z]+\/med_[0-9a-z]+\.png$/,
    )

    // 直传真实 MinIO（与生产同一条 presign → PUT 链路）。
    // 浏览器端 `fetch(url, { method: 'PUT', body: File })` 会按文件类型自动带 Content-Type；
    // 服务端 confirm 读的就是对象上的 Content-Type（MinIO 缺省存成 octet-stream 会被拒）。
    const put = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: pngBytes,
    })
    expect(put.status).toBe(200)

    const confirmRes = await app.request(
      `/transactions/${txnPublicId}/review/media/confirm`,
      json({ objectKey: presign.objectKey }, cookie),
    )
    expect(confirmRes.status).toBe(200)
    const confirm = (await confirmRes.json()) as { objectKey: string; url: string }
    expect(confirm.objectKey).toMatch(/^reviews\/usr_[0-9a-z]+\/med_[0-9a-z]+\.png$/)
    expect(confirm.url).toContain(confirm.objectKey)
    return confirm.objectKey
  }

  test('全链：presign → PUT → confirm → 评价带图（按序读回）→ 删评价级联清图片行', async () => {
    const buyerCookie = await signUp()
    const buyerId = await buyerIdOf(buyerCookie)
    const txn = await createTransaction(buyerId, await createListing())
    const edge = `/transactions/${txn.publicId}/review`

    const firstKey = await uploadImage(buyerCookie, txn.publicId)
    const secondKey = await uploadImage(buyerCookie, txn.publicId)
    expect(firstKey).not.toBe(secondKey)

    // 下单即验证：final 对象真实存在且匿名可读（presign 从不签 reviews/，只能在 confirm 之后出现）。
    const readable = await fetch(`http://localhost:9000/fish/${firstKey}`).catch(() => null)
    if (readable) expect(readable.status).toBe(200)

    const created = await app.request(
      edge,
      json({ rating: 'POSITIVE', imageObjectKeys: [secondKey, firstKey] }, buyerCookie),
    )
    expect(created.status).toBe(201)
    const body = (await created.json()) as {
      images: { url: string }[]
      id: string
    }
    // 数组下标即 sort_order：先 second 后 first，读回按同一顺序。
    expect(body.images.map((image) => image.url)).toEqual([
      expect.stringContaining(secondKey),
      expect.stringContaining(firstKey),
    ])

    // DB 行按 sort_order 落库
    const rows = (await db.execute(sql`
      SELECT object_key, sort_order FROM transaction_review_images
      WHERE review_id = (SELECT id FROM transaction_reviews WHERE transaction_id = ${txn.rawId}::uuid)
      ORDER BY sort_order
    `)) as
      | { rows?: { object_key: string; sort_order: number }[] }
      | { object_key: string; sort_order: number }[]
    const imageRows = Array.isArray(rows) ? rows : (rows.rows ?? [])
    expect(imageRows.map((row) => row.object_key)).toEqual([secondKey, firstKey])
    expect(imageRows.map((row) => row.sort_order)).toEqual([0, 1])

    // 已评价后不能再上传（评价不可修改）
    const afterReview = await app.request(
      `/transactions/${txn.publicId}/review/media/presign`,
      json({ contentType: 'image/png', sizeBytes: 64 }, buyerCookie),
    )
    expect(afterReview.status).toBe(409)
    expect(error(await afterReview.json())).toBe('TRANSACTION_REVIEW_EXISTS')

    // 删除评价 → 图片行级联清掉
    const deleted = await app.request(edge, { ...get(buyerCookie), method: 'DELETE' })
    expect(deleted.status).toBe(200)
    const after = (await db.execute(sql`
      SELECT count(*)::int AS n FROM transaction_review_images
      WHERE review_id = (SELECT id FROM transaction_reviews WHERE transaction_id = ${txn.rawId}::uuid)
    `)) as { rows?: { n: number }[] } | { n: number }[]
    const afterRows = Array.isArray(after) ? after : (after.rows ?? [])
    expect(afterRows[0]?.n).toBe(0)
  })

  test('错误稳定：chat-media 键 / 他人键 / 未确认键在 confirm 与写入两侧都 422 REVIEW_IMAGE_INVALID', async () => {
    const buyerCookie = await signUp()
    const buyerId = await buyerIdOf(buyerCookie)
    const txn = await createTransaction(buyerId, await createListing())
    const other = await signUp()
    const otherId = await buyerIdOf(other)
    const otherTxn = await createTransaction(otherId, await createListing())
    const otherKey = await uploadImage(other, otherTxn.publicId)

    // confirm 侧：staging 键非法
    const chatMediaKey = `chat-media/cnv_01jc000000e008000000000021/usr_01jc000000e00800000000000b/med_01jc000000e00800000000000c.webp`
    for (const objectKey of [
      chatMediaKey,
      'listings/usr_01jc000000e00800000000000b/med_01jc000000e00800000000000c.jpg',
    ]) {
      const res = await app.request(
        `/transactions/${txn.publicId}/review/media/confirm`,
        json({ objectKey }, buyerCookie),
      )
      expect(res.status).toBe(422)
      expect(error(await res.json())).toBe('REVIEW_IMAGE_INVALID')
    }

    // 写入侧：别人的 final 键不可引用
    const res = await app.request(
      `/transactions/${txn.publicId}/review`,
      json({ rating: 'POSITIVE', imageObjectKeys: [otherKey] }, buyerCookie),
    )
    expect(res.status).toBe(422)
    expect(error(await res.json())).toBe('REVIEW_IMAGE_INVALID')
  })

  test('超限（>3）与重复键在 app 级被契约拦下（422 VALIDATION_FAILED）', async () => {
    const buyerCookie = await signUp()
    const buyerId = await buyerIdOf(buyerCookie)
    const txn = await createTransaction(buyerId, await createListing())
    const edge = `/transactions/${txn.publicId}/review`
    const key = await uploadImage(buyerCookie, txn.publicId)

    const dup = await app.request(
      edge,
      json({ rating: 'POSITIVE', imageObjectKeys: [key, key] }, buyerCookie),
    )
    expect(dup.status).toBe(422)
    expect(error(await dup.json())).toBe('VALIDATION_FAILED')

    const over = await app.request(
      edge,
      json({ rating: 'POSITIVE', imageObjectKeys: [key, key, key, key] }, buyerCookie),
    )
    expect(over.status).toBe(422)
    expect(error(await over.json())).toBe('VALIDATION_FAILED')
  })
})
