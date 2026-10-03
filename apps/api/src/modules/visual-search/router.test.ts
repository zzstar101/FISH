import { describe, expect, test } from 'bun:test'
import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import {
  MAX_VISUAL_QUERY_IMAGE_BYTES,
  type VisualQueryUploadResponse,
  VisualQueryUploadResponseSchema,
  type VisualSearchResponse,
  VisualSearchResponseSchema,
} from '@fish/contracts/visual/schema'
import { Hono } from 'hono'
import { VisualSearchRateLimitError } from './rate-limit'
import { createVisualSearchRouter } from './router'
import { type VisualSearchService, VisualSearchServiceError } from './service'
import type { ResolvedVisualSearchSubject, VisualSearchSubjectResolver } from './subject'

/**
 * 路由层单测（#324 M2）。
 *
 * `service` / `subjects` / `resolveViewerId` / `resolveClientIp` 全部是假实现，
 * **不需要数据库、不出网**。只验证 HTTP 边界：状态码、错误码、响应头、响应体契约。
 */
const ISSUED_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const EXISTING_SESSION_ID = '22222222-2222-4222-8222-222222222222'
const OBJECT_KEY = 'visual-search/abc123/33333333-3333-4333-8333-333333333333.png'

const uploadResponse: VisualQueryUploadResponse = {
  objectKey: OBJECT_KEY,
  url: 'https://objects.example.test/visual-search/presigned',
  expiresAt: '2026-09-29T12:00:00.000Z',
}

const searchResponse: VisualSearchResponse = {
  queryId: '44444444-4444-4444-8444-444444444444',
  interpretation: null,
  strategyVersion: 'visual-search-v1',
  embeddingModel: 'stub-visual-embedding',
  items: [],
  stats: { soldAvgPriceCents: null, soldSampleCount: 0 },
}

function fakeService(overrides: Partial<VisualSearchService> = {}): VisualSearchService {
  return {
    createUpload: async () => uploadResponse,
    search: async () => searchResponse,
    ...overrides,
  }
}

function subject(
  overrides: Partial<ResolvedVisualSearchSubject> = {},
): ResolvedVisualSearchSubject {
  return {
    key: { subjectType: 'session', subjectKey: 'subject-key' },
    attempts: [{ subjectType: 'session', subjectKey: 'subject-key' }],
    issuedSessionId: null,
    ...overrides,
  }
}

function fakeSubjects(result: ResolvedVisualSearchSubject): VisualSearchSubjectResolver {
  return { resolve: async () => result }
}

function buildApp(
  options: {
    service?: VisualSearchService
    subjects?: VisualSearchSubjectResolver
    onError?: (error: Error) => void
  } = {},
): Hono {
  const root = new Hono()
  if (options.onError) {
    const capture = options.onError
    root.onError((error, c) => {
      capture(error)
      return c.json({ error: { code: 'UNEXPECTED_ERROR' } }, 500)
    })
  }
  root.route(
    '/visual-search',
    createVisualSearchRouter({
      service: options.service ?? fakeService(),
      subjects: options.subjects ?? fakeSubjects(subject()),
      resolveViewerId: async () => null,
      resolveClientIp: () => '203.0.113.7',
    }),
  )
  return root
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

const validUploadBody = { contentType: 'image/png', sizeBytes: 1024 }
const validSearchBody = { objectKey: OBJECT_KEY }

describe('POST /visual-search/uploads', () => {
  test('合法请求回 200，响应体符合 VisualQueryUploadResponseSchema', async () => {
    const app = buildApp()
    const res = await app.request('/visual-search/uploads', json(validUploadBody))

    expect(res.status).toBe(200)
    const parsed = VisualQueryUploadResponseSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toEqual(uploadResponse)
  })

  test('新签发会话时用契约常量回写响应头', async () => {
    const app = buildApp({
      subjects: fakeSubjects(subject({ issuedSessionId: ISSUED_SESSION_ID })),
    })
    const res = await app.request('/visual-search/uploads', json(validUploadBody))

    expect(res.status).toBe(200)
    expect(res.headers.get(RECOMMENDATION_HEADERS.sessionId)).toBe(ISSUED_SESSION_ID)
  })

  test('已有会话（未新签发）时不覆盖该响应头', async () => {
    const app = buildApp({ subjects: fakeSubjects(subject({ issuedSessionId: null })) })
    const res = await app.request(
      '/visual-search/uploads',
      json(validUploadBody, { [RECOMMENDATION_HEADERS.sessionId]: EXISTING_SESSION_ID }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get(RECOMMENDATION_HEADERS.sessionId)).toBeNull()
  })

  const invalidUploadBodies = [
    ['缺字段', {}],
    ['contentType 不在白名单', { contentType: 'image/gif', sizeBytes: 1024 }],
    ['sizeBytes 超上限', { contentType: 'image/png', sizeBytes: MAX_VISUAL_QUERY_IMAGE_BYTES + 1 }],
    ['多余字段', { contentType: 'image/png', sizeBytes: 1024, extra: true }],
  ] as const

  for (const [name, body] of invalidUploadBodies) {
    test(`非法请求体（${name}）回 422 VALIDATION_FAILED`, async () => {
      const app = buildApp()
      const res = await app.request('/visual-search/uploads', json(body))

      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
    })
  }
})

describe('POST /visual-search', () => {
  test('合法请求回 200，响应体符合 VisualSearchResponseSchema', async () => {
    const app = buildApp()
    const res = await app.request('/visual-search', json(validSearchBody))

    expect(res.status).toBe(200)
    expect(VisualSearchResponseSchema.safeParse(await res.json()).success).toBe(true)
  })

  test('sort 缺省可解析（老客户端只发 objectKey），且不凭空造出一个 sort', async () => {
    const seen: Array<{ objectKey: string; sort?: string }> = []
    const app = buildApp({
      service: fakeService({
        search: async (_subject, input) => {
          seen.push(input)
          return searchResponse
        },
      }),
    })

    const res = await app.request('/visual-search', json(validSearchBody))

    expect(res.status).toBe(200)
    expect(seen).toEqual([{ objectKey: OBJECT_KEY }])
  })

  test('sort 原样透传给 service（排序档不在路由层解释）', async () => {
    const seen: Array<{ objectKey: string; sort?: string }> = []
    const app = buildApp({
      service: fakeService({
        search: async (_subject, input) => {
          seen.push(input)
          return searchResponse
        },
      }),
    })

    const res = await app.request('/visual-search', json({ ...validSearchBody, sort: 'price_asc' }))

    expect(res.status).toBe(200)
    expect(seen).toEqual([{ objectKey: OBJECT_KEY, sort: 'price_asc' }])
  })

  const invalidSearchBodies = [
    ['sort 不在枚举内', { objectKey: OBJECT_KEY, sort: 'cheapest' }],
    ['多余字段（strictObject）', { objectKey: OBJECT_KEY, sort: 'popular', extra: true }],
    ['缺 objectKey', { sort: 'popular' }],
  ] as const

  for (const [name, body] of invalidSearchBodies) {
    test(`非法请求体（${name}）回 422 VALIDATION_FAILED`, async () => {
      const app = buildApp()
      const res = await app.request('/visual-search', json(body))

      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
    })
  }

  const serviceErrorCases = [
    [400, 'VISUAL_SEARCH_IMAGE_INVALID'],
    [413, 'VISUAL_SEARCH_IMAGE_TOO_LARGE'],
    [503, 'VISUAL_SEARCH_PROVIDER_UNAVAILABLE'],
  ] as const

  for (const [status, code] of serviceErrorCases) {
    test(`service 抛 ${status}/${code} 时映射为同状态码与错误码`, async () => {
      const app = buildApp({
        service: fakeService({
          search: async () => {
            throw new VisualSearchServiceError(status, code, '识别失败')
          },
        }),
      })
      const res = await app.request('/visual-search', json(validSearchBody))

      expect(res.status).toBe(status)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code)
    })
  }

  test('带 retryAfterSeconds 的 503 回 Retry-After，不带的没有该头', async () => {
    const withRetry = buildApp({
      service: fakeService({
        search: async () => {
          throw new VisualSearchServiceError(503, 'VISUAL_SEARCH_PROVIDER_UNAVAILABLE', '上游忙', 5)
        },
      }),
    })
    const retried = await withRetry.request('/visual-search', json(validSearchBody))

    expect(retried.status).toBe(503)
    expect(retried.headers.get('Retry-After')).toBe('5')
    expect(
      ((await retried.json()) as { error: { retryAfterSeconds?: number } }).error.retryAfterSeconds,
    ).toBe(5)

    const withoutRetry = buildApp({
      service: fakeService({
        search: async () => {
          throw new VisualSearchServiceError(503, 'VISUAL_SEARCH_NO_EMBEDDING', '数据未就绪')
        },
      }),
    })
    const plain = await withoutRetry.request('/visual-search', json(validSearchBody))

    expect(plain.status).toBe(503)
    expect(plain.headers.get('Retry-After')).toBeNull()
  })

  test('VisualSearchRateLimitError(37) 映射为 429 + VISUAL_SEARCH_RATE_LIMITED + Retry-After: 37', async () => {
    const app = buildApp({
      service: fakeService({
        search: async () => {
          throw new VisualSearchRateLimitError(37)
        },
      }),
    })
    const res = await app.request('/visual-search', json(validSearchBody))

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('37')
    const body = (await res.json()) as { error: { code: string; retryAfterSeconds?: number } }
    expect(body.error.code).toBe('VISUAL_SEARCH_RATE_LIMITED')
    expect(body.error.retryAfterSeconds).toBe(37)
  })

  test('未预期异常继续上抛给 app.onError，而不是被吞成固定文案', async () => {
    const boom = new Error('unexpected boom')
    const captured: Error[] = []
    const app = buildApp({
      service: fakeService({
        search: async () => {
          throw boom
        },
      }),
      onError: (error) => {
        captured.push(error)
      },
    })
    const res = await app.request('/visual-search', json(validSearchBody))

    expect(res.status).toBe(500)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toBe(boom)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNEXPECTED_ERROR')
  })
})

describe('请求体解析', () => {
  test('不是合法 JSON 时回 422 而不是 500', async () => {
    for (const endpoint of ['/visual-search', '/visual-search/uploads']) {
      const app = buildApp()
      const res = await app.request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      })

      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      )
    }
  })
})
