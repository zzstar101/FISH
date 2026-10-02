import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** 与 app.recommendation.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_view_history_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const PASSWORD = 'fish123456'

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function registerUser(serial: string): Promise<{ id: string; cookie: string }> {
  const response = await app.request(
    '/auth/register',
    post({
      studentNo: `2021000000${serial}`,
      password: PASSWORD,
      nickname: `足迹验收${serial}`,
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('fish_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('注册未下发 fish_session cookie')
  return { id: decodePublicId(PUBLIC_ID_PREFIX.user, body.user.id), cookie }
}

async function createListing(sellerId: string, title: string): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title,
    description: '足迹验收',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  return encodePublicId(PUBLIC_ID_PREFIX.listing, id)
}

/** 上报一条 DETAIL_VIEW（可指定时刻与身份 cookie；不传 cookie 即匿名）。 */
async function postDetailView(input: {
  listingPublicId: string
  occurredAt: string
  cookie?: string
  eventId?: string
}): Promise<number> {
  const response = await app.request(
    '/recommendations/events',
    post(
      {
        events: [
          {
            eventId: input.eventId ?? newId(),
            listingId: input.listingPublicId,
            eventType: 'DETAIL_VIEW',
            occurredAt: input.occurredAt,
          },
        ],
      },
      input.cookie === undefined ? {} : { cookie: input.cookie },
    ),
  )
  return response.status
}

interface ViewHistoryBody {
  items: { listing: { id: string; status: string }; viewedAt: string }[]
  nextCursor: string | null
  total: number
}

async function getViewHistory(
  cookie: string | undefined,
  query = '',
): Promise<{ status: number; body: ViewHistoryBody }> {
  const response = await app.request(
    `/me/view-history${query}`,
    cookie === undefined ? {} : { headers: { cookie } },
  )
  const status = response.status
  const body =
    status === 200 ? ((await response.json()) as ViewHistoryBody) : ({} as ViewHistoryBody)
  return { status, body }
}

describe('view history API (#415 M1)', () => {
  test('登录用户上报 DETAIL_VIEW 后能在 /me/view-history 看到，重复浏览只一行且时间更新', async () => {
    const seller = await registerUser('01')
    const viewer = await registerUser('02')
    const listing = await createListing(seller.id, '足迹验收商品')

    expect(
      await postDetailView({
        listingPublicId: listing,
        occurredAt: '2026-10-01T01:00:00.000Z',
        cookie: viewer.cookie,
      }),
    ).toBe(202)

    const first = await getViewHistory(viewer.cookie)
    expect(first.status).toBe(200)
    expect(first.body.total).toBe(1)
    expect(first.body.items[0]?.listing.id).toBe(listing)
    expect(first.body.items[0]?.viewedAt).toBe('2026-10-01T01:00:00.000Z')

    // 再看一次：同一件商品仍是一行，时间被顶新（列表里不会出现两条）。
    await postDetailView({
      listingPublicId: listing,
      occurredAt: '2026-10-01T02:00:00.000Z',
      cookie: viewer.cookie,
    })
    const second = await getViewHistory(viewer.cookie)
    expect(second.body.total).toBe(1)
    expect(second.body.items[0]?.viewedAt).toBe('2026-10-01T02:00:00.000Z')
  })

  test('补发的旧事件不会把时间倒退（GREATEST）', async () => {
    const seller = await registerUser('03')
    const viewer = await registerUser('04')
    const listing = await createListing(seller.id, '补发顺序商品')

    await postDetailView({
      listingPublicId: listing,
      occurredAt: '2026-10-01T05:00:00.000Z',
      cookie: viewer.cookie,
    })
    await postDetailView({
      listingPublicId: listing,
      occurredAt: '2026-10-01T04:00:00.000Z',
      cookie: viewer.cookie,
    })

    const page = await getViewHistory(viewer.cookie)
    expect(page.body.items[0]?.viewedAt).toBe('2026-10-01T05:00:00.000Z')
  })

  test('匿名浏览不进足迹，登录后也不会凭空多出来（不回填）', async () => {
    const seller = await registerUser('05')
    const listing = await createListing(seller.id, '匿名浏览商品')

    // 先匿名看一次，再注册登录。
    expect(
      await postDetailView({ listingPublicId: listing, occurredAt: '2026-10-01T06:00:00.000Z' }),
    ).toBe(202)
    const viewer = await registerUser('06')
    await postDetailView({
      listingPublicId: listing,
      occurredAt: '2026-10-01T07:00:00.000Z',
      cookie: viewer.cookie,
    })

    const page = await getViewHistory(viewer.cookie)
    expect(page.body.total).toBe(1)
    expect(page.body.items[0]?.viewedAt).toBe('2026-10-01T07:00:00.000Z')
  })

  test('未登录读写都是 401 UNAUTHENTICATED', async () => {
    const list = await getViewHistory(undefined)
    expect(list.status).toBe(401)

    const clear = await app.request('/me/view-history', { method: 'DELETE' })
    expect(clear.status).toBe(401)
    const body = (await clear.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  test('分页：游标翻页不重不漏，非法游标 422', async () => {
    const seller = await registerUser('07')
    const viewer = await registerUser('08')
    const listingA = await createListing(seller.id, '分页商品 A')
    const listingB = await createListing(seller.id, '分页商品 B')
    const listingC = await createListing(seller.id, '分页商品 C')

    for (const [listing, hour] of [
      [listingA, '01'],
      [listingB, '02'],
      [listingC, '03'],
    ] as const) {
      await postDetailView({
        listingPublicId: listing,
        occurredAt: `2026-10-01T${hour}:00:00.000Z`,
        cookie: viewer.cookie,
      })
    }

    const first = await getViewHistory(viewer.cookie, '?limit=2')
    expect(first.body.items.map((item) => item.listing.id)).toEqual([listingC, listingB])
    expect(first.body.nextCursor).not.toBeNull()

    const second = await getViewHistory(
      viewer.cookie,
      `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    )
    expect(second.body.items.map((item) => item.listing.id)).toEqual([listingA])
    expect(second.body.nextCursor).toBeNull()

    const bad = await getViewHistory(viewer.cookie, '?cursor=not-a-cursor')
    expect(bad.status).toBe(422)
  })

  test('窗口外的记录读不到、不计入 total', async () => {
    const seller = await registerUser('09')
    const viewer = await registerUser('10')
    const listing = await createListing(seller.id, '过期足迹商品')

    // 直接写一条 31 天前的足迹（走 ingest 会被 `occurred_at_too_old` 拒收，这里是构造读侧边界）。
    await db.insert(listingViewHistory).values({
      userId: viewer.id,
      listingId: decodePublicId(PUBLIC_ID_PREFIX.listing, listing),
      lastViewedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000),
    })

    const page = await getViewHistory(viewer.cookie)
    expect(page.body.total).toBe(0)
    expect(page.body.items).toEqual([])
  })

  test('清空幂等，且不动训练用的 recommendation_events', async () => {
    const seller = await registerUser('11')
    const viewer = await registerUser('12')
    const listing = await createListing(seller.id, '清空验收商品')

    await postDetailView({
      listingPublicId: listing,
      occurredAt: '2026-10-01T08:00:00.000Z',
      cookie: viewer.cookie,
    })

    const cleared = await app.request('/me/view-history', {
      method: 'DELETE',
      headers: { cookie: viewer.cookie },
    })
    expect(cleared.status).toBe(200)
    expect((await cleared.json()) as { deleted: number }).toEqual({ deleted: 1 })

    // 幂等：再清一次回 200 / 0。
    const again = await app.request('/me/view-history', {
      method: 'DELETE',
      headers: { cookie: viewer.cookie },
    })
    expect(again.status).toBe(200)
    expect((await again.json()) as { deleted: number }).toEqual({ deleted: 0 })

    const page = await getViewHistory(viewer.cookie)
    expect(page.body.total).toBe(0)

    // 训练数据不受用户清空影响（Owner 待定项 1 的推荐默认：只清足迹表）。
    const events = await db
      .select({ id: recommendationEvents.id })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.listingId, decodePublicId(PUBLIC_ID_PREFIX.listing, listing)),
          eq(recommendationEvents.eventType, 'DETAIL_VIEW'),
        ),
      )
    expect(events.length).toBeGreaterThan(0)
  })
})
