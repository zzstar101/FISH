import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type {
  NotificationDto,
  NotificationListResponse,
  NotificationUnreadCount,
} from '@fish/contracts/notifications/schema'
import { createDb, type Db } from '@fish/db/client'
import { notifications } from '@fish/db/schema/notifications'
import { loadServerEnv } from '@fish/shared/env'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from './app'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../packages/db/src/migrations', import.meta.url),
)

/** 与 app.wishes.test.ts 相同的 scratch 库模式：不污染开发库，也不受 seed 数据影响。 */
const scratchDatabase = `fish_notifications_app_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
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

/** 两条通知共用的时间戳：用来验「同一 created_at 时按 id DESC」。 */
const SAME_MOMENT = '2026-09-12T10:00:00Z'

/**
 * 每个用例一组独立的 fixture id（通知 id 是主键，跨用例复用会撞行）。
 * `tag` 是 4 位十六进制，塞进 uuid 的第一段，保持 id 是合法 uuid。
 */
function fixtureIds(tag: string) {
  return {
    /** 与 n2 同一 created_at，id 更小。 */
    n1: `0199${tag}-0000-7000-8000-0000000000b1`,
    /** 与 n1 同一 created_at，id 更大 → 排序时应排在 n1 前面。 */
    n2: `0199${tag}-0000-7000-8000-0000000000b2`,
    /** 更早，且已读。 */
    n3: `0199${tag}-0000-7000-8000-0000000000b3`,
    /** 他人的通知：created_at 最新，过滤失效时会立刻出现在我的列表首位。 */
    nOther: `0199${tag}-0000-7000-8000-0000000000b4`,
  }
}

async function registerUser(serial: string): Promise<{ cookie: string; userId: string }> {
  const response = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      studentNo: `2021000000${serial}`,
      password: PASSWORD,
      nickname: `通知用户${serial}`,
      campus: '肇庆',
    }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('fish_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('注册未下发 fish_session cookie')
  const body = (await response.json()) as { user: { id: string } }
  return { cookie, userId: body.user.id }
}

/**
 * 直接插 fixture 行，#23 只消费已存在的通知，不依赖 worker（#8 的匹配引擎才是生产者）。
 * 三行都显式给 created_at：排序断言不能建立在「插入顺序 ≈ 时间顺序」的巧合上。
 */
async function seedNotifications(userId: string, ids: ReturnType<typeof fixtureIds>) {
  await db.execute(sql`
    INSERT INTO notifications (id, user_id, type, payload, read_at, created_at) VALUES
      (${ids.n1}, ${userId}, 'MATCH', ${JSON.stringify({ matchId: ids.n1 })}::jsonb,
       NULL, ${new Date(SAME_MOMENT)}),
      (${ids.n2}, ${userId}, 'MATCH',
       ${JSON.stringify({ matchId: ids.n2, listingId: ids.n3, wishId: ids.nOther })}::jsonb,
       NULL, ${new Date(SAME_MOMENT)}),
      (${ids.n3}, ${userId}, 'MATCH', ${JSON.stringify({})}::jsonb,
       ${new Date('2026-09-12T09:30:00Z')}, ${new Date('2026-09-12T09:00:00Z')})
  `)
}

const get = (path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined)

const markRead = (id: string, cookie?: string) =>
  app.request(`/notifications/${id}/read`, {
    method: 'POST',
    ...(cookie ? { headers: { cookie } } : {}),
  })

const list = async (cookie: string, query = '') => {
  const response = await get(`/notifications${query}`, cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as NotificationListResponse
}

const unreadCount = async (cookie: string) => {
  const response = await get('/notifications/unread-count', cookie)
  expect(response.status).toBe(200)
  return ((await response.json()) as NotificationUnreadCount).unreadCount
}

describe('notifications API wiring (#23)', () => {
  test('未登录：三个端点都是 401 UNAUTHENTICATED，伪造请求头也不被信任', async () => {
    for (const response of [
      await get('/notifications'),
      await get('/notifications/unread-count'),
      await markRead(fixtureIds('0001').n1),
    ]) {
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: { code: 'UNAUTHENTICATED', message: '请先登录' },
      })
    }

    // 身份只认会话 cookie：伪造头不得被 getUserId 当成当前用户。
    const forged = await app.request('/notifications', {
      headers: { 'x-user-id': '00000000-0000-0000-0000-000000000000' },
    })
    expect(forged.status).toBe(401)
  })

  test('GET /notifications 只返回本人的通知，按 created_at DESC, id DESC', async () => {
    const ids = fixtureIds('0002')
    const me = await registerUser('01')
    const other = await registerUser('02')
    await seedNotifications(me.userId, ids)
    await db.execute(sql`
      INSERT INTO notifications (id, user_id, type, payload, created_at)
      VALUES (${ids.nOther}, ${other.userId}, 'MATCH', '{}'::jsonb,
              ${new Date('2026-09-12T23:00:00Z')})
    `)

    // 同一 created_at 的两条按 id DESC（n2 > n1），更早的 n3 在最后；他人的 nOther 虽然最新也不出现。
    const body = await list(me.cookie)
    expect(body.items.map((item) => item.id)).toEqual([ids.n2, ids.n1, ids.n3])

    // DTO 只有 id / type / payload / readAt / createdAt：文案由客户端按 type 渲染，服务端不返回，
    // 也不回 userId（列表与标记已读都只作用于本人）。
    const first = body.items[0] as NotificationDto
    expect(Object.keys(first).sort()).toEqual(['createdAt', 'id', 'payload', 'readAt', 'type'])
    expect(first.readAt).toBeNull()
    expect(new Date(first.createdAt).toISOString()).toBe('2026-09-12T10:00:00.000Z')
    expect(first.payload).toEqual({
      matchId: ids.n2,
      listingId: ids.n3,
      wishId: ids.nOther,
    })

    // 未读的 readAt 是 null；已读的是首次已读时间（与库里 read_at 同口径）。
    expect(body.items.find((item) => item.id === ids.n3)?.readAt).toBe('2026-09-12T09:30:00.000Z')

    // 对方列表里只有自己那条，与我的三条互不混入。
    expect((await list(other.cookie)).items.map((item) => item.id)).toEqual([ids.nOther])
  })

  test('limit 越界 422 VALIDATION_FAILED；默认 20、上限 50', async () => {
    const ids = fixtureIds('0003')
    const me = await registerUser('03')
    await seedNotifications(me.userId, ids)

    for (const query of ['?limit=0', '?limit=51', '?limit=abc', '?limit=']) {
      const response = await get(`/notifications${query}`, me.cookie)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    }

    // 上限内给多少就截多少（n2 最新）。
    expect((await list(me.cookie, '?limit=1')).items.map((item) => item.id)).toEqual([ids.n2])
    expect((await list(me.cookie, '?limit=50')).items).toHaveLength(3)

    // 21 条才能同时验出「默认 20」与「给满上限 50 时不截断」。用独立用户，不干扰上面的断言。
    const many = await registerUser('04')
    await db.execute(sql`
      INSERT INTO notifications (id, user_id, type, payload, created_at)
      SELECT gen_random_uuid(), ${many.userId}, 'MATCH', '{}'::jsonb,
             ${new Date(SAME_MOMENT)}::timestamptz - (g || ' minutes')::interval
      FROM generate_series(1, 21) AS g
    `)
    expect((await list(many.cookie)).items).toHaveLength(20)
    expect((await list(many.cookie, '?limit=50')).items).toHaveLength(21)
  })

  test('unread-count 只算未读，随标记已读变化；标记已读幂等', async () => {
    const ids = fixtureIds('0004')
    const me = await registerUser('05')
    await seedNotifications(me.userId, ids)

    expect(await unreadCount(me.cookie)).toBe(2)

    const first = await markRead(ids.n1, me.cookie)
    expect(first.status).toBe(200)
    const dto = (await first.json()) as NotificationDto
    expect(dto.id).toBe(ids.n1)
    expect(dto.readAt).not.toBeNull()
    expect(await unreadCount(me.cookie)).toBe(1)

    // 幂等：已读再点仍是 200，且返回体（含**首次**已读时间）逐字不变。
    const again = await markRead(ids.n1, me.cookie)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(dto)
    expect(await unreadCount(me.cookie)).toBe(1)

    // 列表与角标同源：同一个未读数不能有第二种答案。
    const body = await list(me.cookie)
    expect(body.items.filter((item) => item.readAt === null)).toHaveLength(1)
  })

  test('他人的通知既不可见也不可标已读（404 NOTIFICATION_NOT_FOUND，且无副作用）', async () => {
    const ids = fixtureIds('0005')
    const me = await registerUser('06')
    const other = await registerUser('07')
    await db.execute(sql`
      INSERT INTO notifications (id, user_id, type, payload, created_at)
      VALUES (${ids.n1}, ${other.userId}, 'MATCH', '{}'::jsonb, ${new Date(SAME_MOMENT)})
    `)

    // 存在但不是我的：与「不存在」同一个 404（不泄漏存在性），不是 403。
    const response = await markRead(ids.n1, me.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'NOTIFICATION_NOT_FOUND', message: '通知不存在' },
    })

    // 未登录与「不是我的」都不能改动那一行：对方的未读数与 read_at 都不变。
    expect(await unreadCount(other.cookie)).toBe(1)
    const [row] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, ids.n1))
    expect(row?.readAt).toBeNull()
  })

  test('契约外的 type 在列表/角标/标记已读三处口径一致（不占 LIMIT、404 零写入）', async () => {
    const ids = fixtureIds('0006')
    const me = await registerUser('09')
    // n1 正常；n2 的 type 不在契约枚举里（库里 `type` 是裸 text、无 CHECK）；n3 的 `read_at`
    // 是 `'infinity'::timestamptz`（PG 合法、JS 的 Date 表示不了）。给 n3 更早的 created_at，
    // 让它排在 LIMIT 之后，免得它掩盖 n2 那条「脏行不吃名额」的断言。
    await db.execute(sql`
      INSERT INTO notifications (id, user_id, type, payload, read_at, created_at) VALUES
        (${ids.n1}, ${me.userId}, 'MATCH', '{"matchId":"a"}'::jsonb, NULL, ${new Date(SAME_MOMENT)}),
        (${ids.n2}, ${me.userId}, 'PRICE_DROP', '{}'::jsonb, NULL, ${new Date(SAME_MOMENT)}),
        (${ids.n3}, ${me.userId}, 'MATCH', '{}'::jsonb,
         'infinity'::timestamptz, ${new Date('2026-09-12T09:00:00Z')})
    `)

    // 不可映射的行**不占 LIMIT 名额**（谓词在 SQL 层，`LIMIT` 只数可映射行）：
    // 一行脏 type + 一行正常时 `?limit=1` 必须给出那行正常的，而不是空页。
    expect((await list(me.cookie, '?limit=1')).items.map((item) => item.id)).toEqual([ids.n1])

    // 契约外/不可表示的行被跳过，且不让整页 500（时间戳那一行走的是 JS 侧的最后一道闸门）。
    expect((await list(me.cookie)).items.map((item) => item.id)).toEqual([ids.n1])

    // 角标与列表**同源**：共用 store 的同一个 type 谓词，所以同为 1
    // （n2 被谓词排除；n3 的 read_at 非空、本就不计未读）。
    expect(await unreadCount(me.cookie)).toBe(1)

    // 标记已读对契约外的行是 404 且**零副作用**：库里 read_at 仍为 NULL，角标也不动。
    expect((await markRead(ids.n2, me.cookie)).status).toBe(404)
    const [dirtyTypeRow] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, ids.n2))
    expect(dirtyTypeRow?.readAt).toBeNull()
    expect(await unreadCount(me.cookie)).toBe(1)
  })

  test('非法 uuid 与不存在的 id 都是 404，不打到 PG 变 500', async () => {
    const me = await registerUser('08')

    const malformed = await markRead('not-a-uuid', me.cookie)
    expect(malformed.status).toBe(404)
    expect(await malformed.json()).toMatchObject({ error: { code: 'NOTIFICATION_NOT_FOUND' } })

    const unknown = await markRead('01990000-0000-7000-8000-0000000000ff', me.cookie)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: 'NOTIFICATION_NOT_FOUND' } })
  })
})
