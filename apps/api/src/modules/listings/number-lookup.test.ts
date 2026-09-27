import { afterAll, beforeAll, expect, test } from 'bun:test'
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingLookupAttempts } from '@fish/db/schema/listing-lookup-attempts'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'
import { createListingNumberLookup, pruneExpiredNumberLookups } from './number-lookup'
import { createListingService } from './service'
import { createSqlListingStore } from './store'
import { normalizeIp, trustedClientIp } from './trusted-ip'

const url = process.env.DATABASE_URL
if (!url) throw new Error('集成测试需要 DATABASE_URL')
const databaseName = `fish_listing_lookup_test_${process.pid}`
const scratchUrl = new URL(url)
scratchUrl.pathname = `/${databaseName}`
const admin = createDb(url)
let db: Db
let sellerId: string
let outsiderId: string
let listingId: string
const listingNo = '348572910465'
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

beforeAll(async () => {
  await admin.$client.unsafe(`CREATE DATABASE "${databaseName}"`)
  db = createDb(scratchUrl.toString())
  await migrate(db, { migrationsFolder })
  sellerId = newId()
  outsiderId = newId()
  listingId = newId()
  await db.insert(users).values([
    { id: sellerId, studentNo: 'lookup-seller', nickname: '卖家', passwordHash: 'test' },
    { id: outsiderId, studentNo: 'lookup-buyer', nickname: '买家', passwordHash: 'test' },
  ])
  await db.insert(listingNumbers).values({ listingNo: BigInt(listingNo), listingId })
  await db.insert(listings).values({
    id: listingId,
    listingNo: BigInt(listingNo),
    sellerId,
    title: '编号查询样本',
    description: '仅测试可见性',
    priceCents: 100,
    category: 'BOOKS',
    condition: 'GOOD',
    status: 'ACTIVE',
  })
})

afterAll(async () => {
  if (db) await db.$client.close()
  await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
  await admin.$client.close()
})

function lookup() {
  const service = createListingService({
    store: createSqlListingStore(db),
    storage: {
      presignPut: () => ({
        url: 'https://upload.test',
        headers: {},
        expiresAt: new Date().toISOString(),
      }),
      stat: async () => null,
      publicUrl: (key) => `https://cdn.test/${key}`,
    },
  })
  return createListingNumberLookup(db, service, 'lookup-test-secret-with-at-least-32-characters')
}

test('编号只返回 canonical TypeID；不可见商品与不存在同为 404 且消耗额度', async () => {
  const numberLookup = lookup()
  const visible = await numberLookup.lookup(listingNo, outsiderId, null)
  expect(decodePublicId(PUBLIC_ID_PREFIX.listing, visible.id)).toBe(listingId)
  await db.update(listings).set({ status: 'OFFLINE' }).where(eq(listings.id, listingId))
  try {
    await expect(numberLookup.lookup(listingNo, outsiderId, null)).rejects.toMatchObject({
      status: 404,
      code: 'LISTING_NOT_FOUND',
    })
    expect(
      decodePublicId(
        PUBLIC_ID_PREFIX.listing,
        (await numberLookup.lookup(listingNo, sellerId, null)).id,
      ),
    ).toBe(listingId)
    await expect(numberLookup.lookup('348572910466', outsiderId, null)).rejects.toMatchObject({
      status: 404,
      code: 'LISTING_NOT_FOUND',
    })
    const attempts = await db.select().from(listingLookupAttempts)
    expect(
      attempts.filter((row) => row.subjectType === 'user' && row.subjectKey === outsiderId),
    ).toHaveLength(3)
  } finally {
    await db.update(listings).set({ status: 'ACTIVE' }).where(eq(listings.id, listingId))
  }
})

test('真实 HTTP 编号查询返回的 lst_ ID 可直接读取详情；错前缀不能访问商品', async () => {
  const app = createApp(
    { ...loadServerEnv(), DATABASE_URL: scratchUrl.toString() },
    undefined,
    undefined,
    undefined,
    undefined,
    { peerIp: () => '192.0.2.99', trustedProxyIp: null },
  )
  const found = await app.request(LISTING_ROUTES.byNumber(listingNo))
  expect(found.status).toBe(200)
  const body = (await found.json()) as { id: string }
  expect(decodePublicId(PUBLIC_ID_PREFIX.listing, body.id)).toBe(listingId)
  const detail = await app.request(LISTING_ROUTES.detail(body.id))
  expect(detail.status).toBe(200)
  expect(await detail.json()).toMatchObject({ id: body.id, listingNo })
  const wrongPrefix = encodePublicId(PUBLIC_ID_PREFIX.user, listingId)
  expect((await app.request(LISTING_ROUTES.detail(wrongPrefix))).status).toBe(404)
})

test('匿名持久滚动额度：50 次合法未命中计入，超限 429；DB 不存原始 IP', async () => {
  const numberLookup = lookup()
  const ip = '192.0.2.53'
  const before = (await db.select().from(listingLookupAttempts)).filter(
    (row) => row.subjectType === 'ip',
  ).length
  for (let i = 0; i < 50; i++) {
    await expect(numberLookup.lookup('348572910466', null, ip)).rejects.toMatchObject({
      status: 404,
    })
  }
  await expect(numberLookup.lookup(listingNo, null, ip)).rejects.toMatchObject({
    status: 429,
    code: 'LISTING_LOOKUP_RATE_LIMITED',
  })
  const attempts = await db.select().from(listingLookupAttempts)
  const anonymous = attempts.filter((row) => row.subjectType === 'ip')
  expect(anonymous).toHaveLength(before + 50)
  expect(
    anonymous.every((row) => /^[0-9a-f]{64}$/.test(row.subjectKey) && !row.subjectKey.includes(ip)),
  ).toBe(true)
  await expect(numberLookup.lookup(listingNo, null, null)).rejects.toMatchObject({
    status: 503,
    code: 'LISTING_LOOKUP_IP_UNAVAILABLE',
  })
})

test('陈旧主体配额可增量清理，不让历史 IP 记录永久累积', async () => {
  const id = newId()
  await db.insert(listingLookupAttempts).values({
    id,
    subjectType: 'ip',
    subjectKey: 'old-hmac',
    createdAt: new Date(Date.now() - 61_000),
  })
  await pruneExpiredNumberLookups(db)
  expect(
    await db.select().from(listingLookupAttempts).where(eq(listingLookupAttempts.id, id)),
  ).toEqual([])
})

test('只信任配置的反代 peer 与它覆盖的单值 IP 头；客户端伪造头不用于计数', () => {
  const direct = new Request('https://fish.test/listings/by-number/348572910465', {
    headers: { 'x-real-ip': '1.2.3.4' },
  })
  expect(trustedClientIp(direct, '192.0.2.10', null)).toBeNull()
  expect(trustedClientIp(direct, '192.0.2.10', '127.0.0.1')).toBeNull()
  expect(trustedClientIp(direct, '127.0.0.1', '127.0.0.1')).toBe('1.2.3.4')
  expect(trustedClientIp(new Request('https://fish.test'), null, null)).toBeNull()
  expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
  expect(normalizeIp('1.2.3.4, 5.6.7.8')).toBeNull()
})
