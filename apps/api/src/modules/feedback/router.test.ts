import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import { FEEDBACK_ROUTES } from '@fish/contracts/feedback/routes'
import { FEEDBACK_DAILY_LIMIT } from '@fish/contracts/feedback/schema'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { feedback } from '@fish/db/schema/feedback'
import { users } from '@fish/db/schema/users'
import { loadServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createApp } from '../../app'

/**
 * 意见反馈闭环端到端（#463）：用户提交 → 管理队列 → 处理 / 回复 → 用户查看结果。
 *
 * 与 reports 测试同款自建 scratch 库：反馈会插入行、处理会写审计，跑在开发库会污染他人。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_feedback_test_${process.pid}`
const databaseUrlFor = (name: string) => {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}
const scratchUrl = databaseUrlFor(scratchDatabase)
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const admin = createDb(databaseUrl)
let scratch: Db
let app: ReturnType<typeof createApp>

const DEMO_PASSWORD = 'fish123456'
const ADMIN_ID = '01930000-0000-7000-8000-000000000a91'
const USER_ID = '01930000-0000-7000-8000-000000000a92'
const OTHER_USER_ID = '01930000-0000-7000-8000-000000000a93'
const LIMITED_USER_ID = '01930000-0000-7000-8000-000000000a94'

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  app = createApp({ ...loadServerEnv(), DATABASE_URL: scratchUrl })

  const passwordHash = await Bun.password.hash(DEMO_PASSWORD)
  await scratch.insert(users).values([
    { id: ADMIN_ID, studentNo: '202101000991', passwordHash, nickname: '管理员甲', role: 'ADMIN' },
    { id: USER_ID, studentNo: '202101000992', passwordHash, nickname: '用户乙', role: 'USER' },
    {
      id: OTHER_USER_ID,
      studentNo: '202101000993',
      passwordHash,
      nickname: '用户丙',
      role: 'USER',
    },
    {
      id: LIMITED_USER_ID,
      studentNo: '202101000994',
      passwordHash,
      nickname: '用户丁',
      role: 'USER',
    },
  ])
})

afterAll(async () => {
  await scratch.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

const postAs = (cookie: string | null, body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
})

async function loginAs(studentNo: string): Promise<string> {
  const res = await app.request('/auth/login', postAs(null, { studentNo, password: DEMO_PASSWORD }))
  expect(res.status).toBe(200)
  const session = res.headers.getSetCookie().find((value) => value.startsWith('fish_session='))
  if (!session) throw new Error('响应未下发 fish_session')
  return session.split(';')[0] ?? ''
}

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

type FeedbackBody = {
  id: string
  status: string
  contact: string | null
  reply: string | null
  handledAt: string | null
}

let adminCookie: string
let userCookie: string
let otherCookie: string
let feedbackId: string

describe('意见反馈（#463 用户端）', () => {
  test('setup: login', async () => {
    adminCookie = await loginAs('202101000991')
    userCookie = await loginAs('202101000992')
    otherCookie = await loginAs('202101000993')
  })

  test('匿名不能提交，也不能看我的反馈（401）', async () => {
    expect((await app.request(FEEDBACK_ROUTES.create, postAs(null, {}))).status).toBe(401)
    expect((await app.request(FEEDBACK_ROUTES.mine)).status).toBe(401)
  })

  test('正文少于 5 字、类型不在清单里都是 422', async () => {
    const short = await app.request(
      FEEDBACK_ROUTES.create,
      postAs(userCookie, { clientRequestId: newId(), type: 'BUG', content: '太短' }),
    )
    expect(short.status).toBe(422)
    const badType = await app.request(
      FEEDBACK_ROUTES.create,
      postAs(userCookie, { clientRequestId: newId(), type: 'PRAISE', content: '这是一条反馈正文' }),
    )
    expect(badType.status).toBe(422)
  })

  test('提交真实入库（201）；同一 clientRequestId 重试返回同一条（200 + created:false）', async () => {
    const body = {
      clientRequestId: newId(),
      type: 'BUG',
      content: '发布页上传图片后一直转圈',
      contact: 'wx_fish_user',
    }
    const first = await app.request(FEEDBACK_ROUTES.create, postAs(userCookie, body))
    expect(first.status).toBe(201)
    const created = (await first.json()) as { feedback: FeedbackBody; created: boolean }
    expect(created.created).toBe(true)
    expect(created.feedback).toMatchObject({
      status: 'PENDING',
      contact: 'wx_fish_user',
      reply: null,
    })
    feedbackId = created.feedback.id

    const retry = await app.request(FEEDBACK_ROUTES.create, postAs(userCookie, body))
    expect(retry.status).toBe(200)
    const replayed = (await retry.json()) as { feedback: FeedbackBody; created: boolean }
    expect(replayed).toMatchObject({ created: false, feedback: { id: feedbackId } })
    expect(await scratch.$count(feedback, eq(feedback.userId, USER_ID))).toBe(1)
  })

  test('「我的反馈」只返回自己的', async () => {
    const mine = await app.request(FEEDBACK_ROUTES.mine, { headers: { cookie: userCookie } })
    expect(mine.status).toBe(200)
    const { items } = (await mine.json()) as { items: FeedbackBody[] }
    expect(items.map((item) => item.id)).toEqual([feedbackId])

    const others = await app.request(FEEDBACK_ROUTES.mine, { headers: { cookie: otherCookie } })
    expect(((await others.json()) as { items: FeedbackBody[] }).items).toEqual([])
  })

  test(`24 小时内第 ${FEEDBACK_DAILY_LIMIT + 1} 条是 429；并发提交不会越过上限`, async () => {
    const limitedCookie = await loginAs('202101000994')
    const submit = () =>
      app.request(
        FEEDBACK_ROUTES.create,
        postAs(limitedCookie, {
          clientRequestId: newId(),
          type: 'OTHER',
          content: '一条频控测试反馈',
        }),
      )
    const results = await Promise.all(
      Array.from({ length: FEEDBACK_DAILY_LIMIT + 3 }, () => submit()),
    )
    const statuses = results.map((res) => res.status).sort()
    expect(statuses.filter((status) => status === 201).length).toBe(FEEDBACK_DAILY_LIMIT)
    expect(statuses.filter((status) => status === 429).length).toBe(3)
    expect(await scratch.$count(feedback, eq(feedback.userId, LIMITED_USER_ID))).toBe(
      FEEDBACK_DAILY_LIMIT,
    )
  })
})

describe('意见反馈（#463 用户端分页）', () => {
  test('空联系方式等同没留；「我的反馈」按游标翻页不重不漏', async () => {
    const extra = await app.request(
      FEEDBACK_ROUTES.create,
      postAs(userCookie, {
        clientRequestId: newId(),
        type: 'UX',
        content: '希望支持暗色模式',
        contact: '',
      }),
    )
    expect(extra.status).toBe(201)
    expect(((await extra.json()) as { feedback: FeedbackBody }).feedback.contact).toBeNull()

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) })
      const res = await app.request(`${FEEDBACK_ROUTES.mine}?${query}`, {
        headers: { cookie: userCookie },
      })
      expect(res.status).toBe(200)
      const page = (await res.json()) as { items: FeedbackBody[]; nextCursor: string | null }
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(2)
    expect(new Set(seen).size).toBe(2)
    expect(seen).toContain(feedbackId)
  })
})

describe('意见反馈（#463 管理端）', () => {
  test('普通用户碰队列 / 详情 / 处理都是 403', async () => {
    const headers = { cookie: userCookie }
    expect((await app.request(ADMIN_ROUTES.feedback, { headers })).status).toBe(403)
    expect((await app.request(ADMIN_ROUTES.feedbackDetail(feedbackId), { headers })).status).toBe(
      403,
    )
    const handle = await app.request(
      ADMIN_ROUTES.feedbackHandle(feedbackId),
      postAs(userCookie, { result: 'CLOSED', note: '越权' }),
    )
    expect(handle.status).toBe(403)
  })

  test('错误前缀与不存在的反馈是 404 FEEDBACK_NOT_FOUND', async () => {
    const wrongPrefix = encodePublicId(
      PUBLIC_ID_PREFIX.report,
      decodePublicId(PUBLIC_ID_PREFIX.feedback, feedbackId),
    )
    const res = await app.request(ADMIN_ROUTES.feedbackDetail(wrongPrefix), {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('FEEDBACK_NOT_FOUND')

    const missing = encodePublicId(PUBLIC_ID_PREFIX.feedback, newId())
    const handle = await app.request(
      ADMIN_ROUTES.feedbackHandle(missing),
      postAs(adminCookie, { result: 'CLOSED', note: '不存在' }),
    )
    expect(handle.status).toBe(404)
    expect(await errorCode(handle)).toBe('FEEDBACK_NOT_FOUND')
  })

  test('队列按状态 / 类型筛选，管理端能看到联系方式与提交人', async () => {
    const res = await app.request(`${ADMIN_ROUTES.feedback}?status=PENDING&type=BUG`, {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const { items } = (await res.json()) as {
      items: { feedback: FeedbackBody; submitter: { nickname: string } }[]
    }
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      feedback: { id: feedbackId, contact: 'wx_fish_user' },
      submitter: { nickname: '用户乙' },
    })
  })

  test('REPLIED 必须带回复；CLOSED 不能带回复（422）', async () => {
    const noReply = await app.request(
      ADMIN_ROUTES.feedbackHandle(feedbackId),
      postAs(adminCookie, { result: 'REPLIED', note: '备注' }),
    )
    expect(noReply.status).toBe(422)
    const closedWithReply = await app.request(
      ADMIN_ROUTES.feedbackHandle(feedbackId),
      postAs(adminCookie, { result: 'CLOSED', reply: '不该有', note: '备注' }),
    )
    expect(closedWithReply.status).toBe(422)
  })

  test('审计写入失败时业务回滚：反馈仍 PENDING，且无审计行', async () => {
    await scratch.$client.unsafe(`
      CREATE OR REPLACE FUNCTION fish_test_fail_feedback_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.reason LIKE 'AUDIT_FAIL_INJECT%' THEN
          RAISE EXCEPTION 'injected audit failure for feedback rollback test';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `)
    await scratch.$client.unsafe(`
      CREATE TRIGGER fish_test_fail_feedback_audit_trigger
      BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION fish_test_fail_feedback_audit()
    `)
    try {
      const res = await app.request(
        ADMIN_ROUTES.feedbackHandle(feedbackId),
        postAs(adminCookie, { result: 'REPLIED', reply: '已修复', note: 'AUDIT_FAIL_INJECT' }),
      )
      expect(res.status).toBe(500)
    } finally {
      await scratch.$client.unsafe(
        'DROP TRIGGER IF EXISTS fish_test_fail_feedback_audit_trigger ON admin_audit_logs',
      )
      await scratch.$client.unsafe('DROP FUNCTION IF EXISTS fish_test_fail_feedback_audit()')
    }
    const internalId = decodePublicId(PUBLIC_ID_PREFIX.feedback, feedbackId)
    const [row] = await scratch.select().from(feedback).where(eq(feedback.id, internalId))
    expect(row).toMatchObject({ status: 'PENDING', reply: null, handledBy: null })
    expect(await scratch.$count(adminAuditLogs, eq(adminAuditLogs.targetId, internalId))).toBe(0)
  })

  test('两个管理员同时处理：恰好一个 204、另一个 409，只写一条审计', async () => {
    const [a, b] = await Promise.all([
      app.request(
        ADMIN_ROUTES.feedbackHandle(feedbackId),
        postAs(adminCookie, {
          result: 'REPLIED',
          reply: '已在新版本修复，请更新后再试',
          note: '已修复',
        }),
      ),
      app.request(
        ADMIN_ROUTES.feedbackHandle(feedbackId),
        postAs(adminCookie, { result: 'CLOSED', note: '重复' }),
      ),
    ])
    const statuses = [a?.status, b?.status].sort()
    expect(statuses).toEqual([204, 409])
    const internalId = decodePublicId(PUBLIC_ID_PREFIX.feedback, feedbackId)
    expect(await scratch.$count(adminAuditLogs, eq(adminAuditLogs.targetId, internalId))).toBe(1)
  })

  test('审计快照不含正文与联系方式；审计页能按 FEEDBACK_DECISION 查到', async () => {
    const internalId = decodePublicId(PUBLIC_ID_PREFIX.feedback, feedbackId)
    const [audit] = await scratch
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, internalId))
    expect(JSON.stringify(audit?.after)).not.toContain('wx_fish_user')
    expect(JSON.stringify(audit?.after)).not.toContain('转圈')

    const res = await app.request(`${ADMIN_ROUTES.auditLogs}?action=FEEDBACK_DECISION`, {
      headers: { cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { action: string; targetType: string; targetId: string }[]
    }
    expect(body.items[0]).toMatchObject({
      action: 'FEEDBACK_DECISION',
      targetType: 'FEEDBACK',
      targetId: feedbackId,
    })
  })

  test('用户在「我的反馈」看到处理结果；内部备注不外泄', async () => {
    const mine = await app.request(FEEDBACK_ROUTES.mine, { headers: { cookie: userCookie } })
    const { items } = (await mine.json()) as { items: (FeedbackBody & Record<string, unknown>)[] }
    const item = items.find((candidate) => candidate.id === feedbackId)
    expect(item?.status === 'REPLIED' || item?.status === 'CLOSED').toBe(true)
    expect(item?.handledAt).not.toBeNull()
    if (item?.status === 'REPLIED') expect(item.reply).toBe('已在新版本修复，请更新后再试')
    else expect(item?.reply).toBeNull()
    expect(item).not.toHaveProperty('handlingNote')
  })
})
