import { describe, expect, test } from 'bun:test'
import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import { Hono } from 'hono'
import {
  createVisualSearchSubjectResolver,
  type ResolvedVisualSearchSubject,
  type VisualSearchSubjectResolver,
} from './subject'

/**
 * 主体归属单测（#324 M2）。
 *
 * 只依赖请求头与传入的 `clientIp`，**不需要数据库、不出网**。用真实的 Hono `Context` 读取
 * `x-anonymous-session-id`（不 mock `readAnonymousSessionId`），这样"非法头按缺失处理"
 * 走的是真实解析路径，而不是测试自造的假分支。
 */
const SECRET = 'visual-search-test-secret'
const USER_ID = '01930000-0000-7000-8000-0000000000aa'
const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const CLIENT_IP = '203.0.113.7'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 断言是合法 UUID 并把它收窄成 string（后续比较需要非 null 类型）。 */
function expectUuid(value: string | null): string {
  if (value === null) throw new Error('期望签发会话标识，实际是 null')
  expect(value).toMatch(UUID_RE)
  return value
}

async function resolve(
  resolver: VisualSearchSubjectResolver,
  input: { session?: string; viewerId?: string | null; clientIp?: string | null } = {},
): Promise<ResolvedVisualSearchSubject> {
  const app = new Hono()
  app.get('/', async (c) =>
    c.json(await resolver.resolve(c, input.viewerId ?? null, input.clientIp ?? null)),
  )
  const res = await app.request(
    '/',
    input.session === undefined
      ? undefined
      : { headers: { [RECOMMENDATION_HEADERS.sessionId]: input.session } },
  )
  expect(res.status).toBe(200)
  return (await res.json()) as ResolvedVisualSearchSubject
}

/** 与 `subject.ts` 的 `digest` 同构：HMAC-SHA256(secret, message) 的十六进制串。 */
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

describe('登录用户', () => {
  test('只按 user 主体计数，忽略会话头与 IP，且不签发会话', async () => {
    const result = await resolve(createVisualSearchSubjectResolver(SECRET), {
      viewerId: USER_ID,
      session: SESSION_ID,
      clientIp: CLIENT_IP,
    })

    expect(result.key).toEqual({ subjectType: 'user', subjectKey: USER_ID })
    expect(result.attempts).toEqual([{ subjectType: 'user', subjectKey: USER_ID }])
    expect(result.issuedSessionId).toBeNull()
  })
})

describe('匿名 + 合法会话 + IP', () => {
  test('主体是会话，attempts 同时含 session 与 ip，且两条都是 HMAC 摘要而非原值', async () => {
    const result = await resolve(createVisualSearchSubjectResolver(SECRET), {
      session: SESSION_ID,
      clientIp: CLIENT_IP,
    })

    expect(result.key.subjectType).toBe('session')
    expect(result.issuedSessionId).toBeNull()
    expect(result.attempts).toHaveLength(2)

    const sessionAttempt = result.attempts.find((attempt) => attempt.subjectType === 'session')
    const ipAttempt = result.attempts.find((attempt) => attempt.subjectType === 'ip')
    expect(sessionAttempt?.subjectKey).toBe(result.key.subjectKey)
    expect(sessionAttempt?.subjectKey).not.toBe(SESSION_ID)
    expect(ipAttempt?.subjectKey).toBeDefined()
    expect(ipAttempt?.subjectKey).not.toBe(CLIENT_IP)
  })
})

describe('匿名无任何标识', () => {
  test('新签发合法 UUID 会话，key 是它的 HMAC 而不是原值，但**不进**配额桶', async () => {
    const result = await resolve(createVisualSearchSubjectResolver(SECRET))
    const issued = expectUuid(result.issuedSessionId)

    expect(result.key.subjectType).toBe('session')
    expect(result.key.subjectKey.length).toBeGreaterThan(0)
    expect(result.key.subjectKey).not.toBe(issued)

    // 新签发的会话本次没有任何历史。把它当配额桶等于**每请求一个新桶**（额度永远打不满），
    // 所以配额只剩确定性的共享兜底桶，且它与对象键主体不是同一个值。
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]?.subjectType).toBe('ip')
    expect(result.attempts[0]?.subjectKey).not.toBe(result.key.subjectKey)
  })

  test('兜底桶在多次请求间稳定：伪造身份无法靠"每次新主体"重置额度', async () => {
    const resolver = createVisualSearchSubjectResolver(SECRET)
    const first = await resolve(resolver)
    const second = await resolve(resolver)

    expect(second.attempts).toEqual(first.attempts)
    // 对象键主体仍然每次新签（上传与搜索要靠回写的会话头对齐），但配额主体不变。
    expect(second.key.subjectKey).not.toBe(first.key.subjectKey)
  })
})

describe('匿名只有 IP、没有会话', () => {
  // `subject.ts:97-116`：对象键主体**总是**新签一个会话（上传要拿 presign、搜索要引用同一个对象键，
  // 两者必须落在同一主体上，所以路由器把新会话回写在响应头里），但配额只算**稳定身份**。
  // 新会话没有历史，算它等于没有桶 —— 客户端清一下本地存储就能重置配额。所以配额只剩 IP 一条。
  test('配额只有 IP 一条（新签会话不计入），且不落原值', async () => {
    const result = await resolve(createVisualSearchSubjectResolver(SECRET), { clientIp: CLIENT_IP })

    const issued = expectUuid(result.issuedSessionId)
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]?.subjectType).toBe('ip')
    // 必须都是 HMAC 摘要，绝不能让原始会话标识或原始 IP 落库。
    expect(result.attempts[0]?.subjectKey).not.toBe(issued)
    expect(result.attempts[0]?.subjectKey).not.toBe(CLIENT_IP)
  })
})

describe('IP 不可归因时 fail-closed（伪造转发头）', () => {
  // `apps/api/src/modules/listings/trusted-ip.ts:25-33`：未配置可信代理时，只要请求带
  // `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip` 就返回 null（无法归因）。
  // 如果这里顺势把 IP 桶省掉，再配合"每次新签会话"，客户端的两个桶都会是空的 ⇒ 限流被完全绕过
  // （实测：伪造 `X-Forwarded-For` 且不带会话头，25/25 全部 200）。
  // 所以 IP 缺失必须落**共享兜底桶**：所有无法归因的流量共用一份额度。
  test('没有 IP 也没有会话时仍有配额桶，且是确定性的共享桶', async () => {
    const resolver = createVisualSearchSubjectResolver(SECRET)
    const first = await resolve(resolver)
    const second = await resolve(resolver)

    expect(first.attempts).toHaveLength(1)
    expect(first.attempts[0]?.subjectType).toBe('ip')
    expect(second.attempts).toEqual(first.attempts)
  })

  test('带会话但 IP 不可归因：会话桶 + 共享 IP 桶，共两条', async () => {
    const resolver = createVisualSearchSubjectResolver(SECRET)
    const withSession = await resolve(resolver, { session: SESSION_ID })
    const anonymous = await resolve(resolver)

    expect(withSession.attempts.map((attempt) => attempt.subjectType).sort()).toEqual([
      'ip',
      'session',
    ])
    expect(
      withSession.attempts.find((attempt) => attempt.subjectType === 'session')?.subjectKey,
    ).toBe(withSession.key.subjectKey)

    // 共享桶与"完全没有身份"的请求是同一个桶：换会话也绕不过它。
    expect(withSession.attempts.find((attempt) => attempt.subjectType === 'ip')?.subjectKey).toBe(
      anonymous.attempts.find((attempt) => attempt.subjectType === 'ip')?.subjectKey,
    )
  })

  test('有真实 IP 时不与兜底桶混用', async () => {
    const resolver = createVisualSearchSubjectResolver(SECRET)
    const withIp = await resolve(resolver, { clientIp: CLIENT_IP })
    const anonymous = await resolve(resolver)

    expect(withIp.attempts.find((attempt) => attempt.subjectType === 'ip')?.subjectKey).not.toBe(
      anonymous.attempts.find((attempt) => attempt.subjectType === 'ip')?.subjectKey,
    )
  })
})

describe('HMAC 确定性', () => {
  test('同一 secret + 同一会话稳定；换 secret 得到不同 subjectKey', async () => {
    const first = await resolve(createVisualSearchSubjectResolver(SECRET), { session: SESSION_ID })
    const second = await resolve(createVisualSearchSubjectResolver(SECRET), { session: SESSION_ID })
    const rotated = await resolve(createVisualSearchSubjectResolver(`${SECRET}-rotated`), {
      session: SESSION_ID,
    })

    expect(second.key.subjectKey).toBe(first.key.subjectKey)
    expect(rotated.key.subjectKey).not.toBe(first.key.subjectKey)
  })

  test('同一字面值在 session 与 ip 两个领域下是不同的桶（领域分隔）', async () => {
    // 两种输入格式互斥（会话必须是 UUID、IP 必须是合法 IP），同一个字面值无法同时走两条路，
    // 所以这里用同一把密钥直接比对两个领域前缀下的摘要，确认领域分隔确实生效。
    const literal = CLIENT_IP
    const sessionDigest = await hmacHex(SECRET, `visual-search-session:${literal}`)
    const ipDigest = await hmacHex(SECRET, `visual-search-ip:${literal}`)
    expect(sessionDigest).not.toBe(ipDigest)

    // 解析器对同一个字面值走的是 ip 领域，不会与 session 领域串桶。
    const result = await resolve(createVisualSearchSubjectResolver(SECRET), { clientIp: literal })
    const ipAttempt = result.attempts.find((attempt) => attempt.subjectType === 'ip')
    expect(ipAttempt?.subjectKey).toBe(ipDigest)
    expect(ipAttempt?.subjectKey).not.toBe(sessionDigest)
  })
})

describe('非法会话头', () => {
  test('不是 UUID 时按"没有会话"处理，走签发分支且不抛错', async () => {
    const result = await resolve(createVisualSearchSubjectResolver(SECRET), {
      session: 'not-a-uuid',
      clientIp: CLIENT_IP,
    })

    expectUuid(result.issuedSessionId)
    expect(result.attempts.some((attempt) => attempt.subjectKey === 'not-a-uuid')).toBe(false)
    expect(result.attempts.some((attempt) => attempt.subjectType === 'ip')).toBe(true)
  })
})
