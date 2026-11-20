import { describe, expect, test } from 'bun:test'
import type { ProfileModerationQueueItem } from '@fish/contracts/profile/moderation'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { createProfileModerationRouter } from './moderation-router'
import type { ProfileModerationService } from './moderation-service'
import { ProfileModerationServiceError } from './moderation-service'

const RECORD_ID = encodePublicId(
  PUBLIC_ID_PREFIX.profileModerationRecord,
  '01930000-0000-7000-8000-000000000031',
)
const USER_ID = '01930000-0000-7000-8000-00000000000b'
const ADMIN_ID = '01930000-0000-7000-8000-0000000000a0'

const item: ProfileModerationQueueItem = {
  id: RECORD_ID,
  userId: encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
  nickname: '待审昵称',
  signature: null,
  avatarUrl: null,
  fields: ['nickname'],
  currentNickname: '阿岚',
  currentSignature: null,
  currentAvatarUrl: null,
  author: { id: encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID), nickname: '阿岚' },
  machineDecision: 'REVIEW',
  provider: 'LOCAL',
  policyVersion: 'local-v1',
  suggestion: 'Review',
  score: null,
  matchedRules: ['PUBLIC_EXTERNAL_CONTACT'],
  matchedTermsMasked: [],
  status: 'PENDING',
  decision: null,
  version: 0,
  createdAt: '2026-09-12T03:40:10.000Z',
}

function fakeService(overrides: Partial<ProfileModerationService> = {}): ProfileModerationService {
  return {
    list: async () => ({ items: [item], nextCursor: null }),
    decide: async (recordId, input) => ({
      id: encodePublicId(PUBLIC_ID_PREFIX.profileModerationRecord, recordId),
      userId: encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
      decision: input.decision,
      replayed: false,
    }),
    ...overrides,
  }
}

/** 与 admin router 同构：登录守卫在前、管理员守卫在后，403 由后者给出。 */
function buildApp(options: {
  service: ProfileModerationService
  authed?: boolean
  admin?: boolean
}): Hono<{ Variables: AuthVariables }> {
  const root = new Hono<{ Variables: AuthVariables }>()
  const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (options.authed === false) {
      return c.json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401)
    }
    c.set('userId', ADMIN_ID)
    await next()
  }
  const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (options.admin === false) {
      return c.json({ error: { code: 'FORBIDDEN', message: '无权访问' } }, 403)
    }
    await next()
  }
  root.route(
    '/',
    createProfileModerationRouter({
      service: options.service,
      requireAuth,
      requireAdmin,
    }),
  )
  return root
}

function decisionBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('profile moderation router（#694 M5 资料待审）', () => {
  test('未登录 401、非管理员 403', async () => {
    const anonymous = await buildApp({ service: fakeService(), authed: false }).request('/')
    expect(anonymous.status).toBe(401)

    const plainUser = await buildApp({ service: fakeService(), admin: false }).request('/')
    expect(plainUser.status).toBe(403)
  })

  test('GET / 回队列与游标', async () => {
    const res = await buildApp({ service: fakeService() }).request('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [item], nextCursor: null })
  })

  test('GET / 拒绝非法 limit（422 VALIDATION_FAILED）', async () => {
    let listed = false
    const res = await buildApp({
      service: fakeService({
        list: async () => {
          listed = true
          return { items: [], nextCursor: null }
        },
      }),
    }).request('/?limit=999')
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    expect(listed).toBe(false)
  })

  test('POST 决策：非公开 ID 404、坏请求体 422、服务错误原样映射', async () => {
    const app = buildApp({ service: fakeService() })

    const badId = await app.request('/not-a-public-id/decision', decisionBody({}))
    expect(badId.status).toBe(404)
    expect(await badId.json()).toMatchObject({ error: { code: 'PROFILE_MODERATION_NOT_FOUND' } })

    const badBody = await app.request(`/${RECORD_ID}/decision`, decisionBody({ decision: 'ALLOW' }))
    expect(badBody.status).toBe(422)
    expect(await badBody.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })

    const notFound = await buildApp({
      service: fakeService({
        decide: async () => {
          throw new ProfileModerationServiceError(
            'PROFILE_MODERATION_NOT_FOUND',
            404,
            '待审记录不存在',
          )
        },
      }),
    }).request(
      `/${RECORD_ID}/decision`,
      decisionBody({ decision: 'ALLOW', reason: '合规', version: 0 }),
    )
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toMatchObject({
      error: { code: 'PROFILE_MODERATION_NOT_FOUND', message: '待审记录不存在' },
    })

    const conflict = await buildApp({
      service: fakeService({
        decide: async () => {
          throw new ProfileModerationServiceError(
            'PROFILE_MODERATION_CONFLICT',
            409,
            '审核结论已被其他人处理或版本已变化，请刷新后重试',
          )
        },
      }),
    }).request(
      `/${RECORD_ID}/decision`,
      decisionBody({ decision: 'BLOCK', reason: '含外链', version: 0 }),
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'PROFILE_MODERATION_CONFLICT' } })
  })

  test('POST 决策成功：回公开 ID 与 replayed', async () => {
    const calls: { recordId: string; actor: string }[] = []
    const app = buildApp({
      service: fakeService({
        decide: async (recordId, input, actorUserId) => {
          calls.push({ recordId, actor: actorUserId })
          return {
            id: encodePublicId(PUBLIC_ID_PREFIX.profileModerationRecord, recordId),
            userId: encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
            decision: input.decision,
            replayed: true,
          }
        },
      }),
    })
    const res = await app.request(
      `/${RECORD_ID}/decision`,
      decisionBody({ decision: 'ALLOW', reason: '人工放行', version: 3 }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: RECORD_ID,
      userId: encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID),
      decision: 'ALLOW',
      replayed: true,
    })
    // 服务端只认自己解析出来的 UUID 与会话里的管理员 ID，不信任请求体。
    expect(calls).toEqual([
      {
        recordId: decodePublicId(PUBLIC_ID_PREFIX.profileModerationRecord, RECORD_ID),
        actor: ADMIN_ID,
      },
    ])
  })
})
