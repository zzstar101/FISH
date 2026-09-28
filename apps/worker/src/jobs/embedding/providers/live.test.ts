import { afterEach, expect, test } from 'bun:test'
import { EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { createLiveEmbeddingProvider, EMBEDDING_MAX_ATTEMPTS, EMBEDDING_TIMEOUT_MS } from './live'

/**
 * live provider 的单测：**不出网**，用假 fetch 钉住请求形状、失败分类与重试次数上限。
 * M4 的真实 live smoke 是另一件事（需要密钥），这里只保证实现存在且 fail-closed。
 */
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const config = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-not-a-real-key',
  model: 'live-model-v1',
  // 退避压到 0：这里验证的是"重试几次"，不是"等多久"，不真等就不会拖慢测试。
  retryDelayMs: 0,
}

function vectorOf(value: number): number[] {
  return new Array<number>(EMBEDDING_DIMENSIONS).fill(value)
}

type Captured = { url: string; init: RequestInit | undefined }

function stubFetch(handler: (captured: Captured, index: number) => Response | Promise<Response>) {
  const captured: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const index = captured.length
    captured.push({ url, init })
    return handler({ url, init }, index)
  }) as typeof fetch
  return captured
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('成功路径：POST 到 baseUrl 去尾斜杠 + /embeddings，body 带 model/input，返回向量原样透传', async () => {
  const captured = stubFetch(() =>
    jsonResponse({ data: [{ embedding: vectorOf(0.5) }, { embedding: vectorOf(-0.25) }] }),
  )
  const provider = createLiveEmbeddingProvider(config)

  const vectors = await provider.embed(['苹果降噪耳机', 'AirPods Pro 2'])

  expect(provider.model).toBe('live-model-v1')
  expect(provider.dimensions).toBe(EMBEDDING_DIMENSIONS)
  expect(vectors).toEqual([vectorOf(0.5), vectorOf(-0.25)])

  const request = captured[0]
  expect(request?.url).toBe('https://api.example.com/v1/embeddings')
  expect(request?.init?.method).toBe('POST')
  const headers = request?.init?.headers as Record<string, string> | undefined
  expect(headers?.authorization).toBe('Bearer sk-not-a-real-key')
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    model: 'live-model-v1',
    input: ['苹果降噪耳机', 'AirPods Pro 2'],
  })
  // 超时必须显式挂在请求上，否则一个卡住的上游会占住 worker 的整个轮询循环。
  expect(request?.init?.signal).toBeInstanceOf(AbortSignal)
})

test('5xx 抛 http_status、重试到上限，且不回显响应体（响应体可能含上游细节）', async () => {
  const captured = stubFetch(
    () => new Response('upstream said: sk-leaked-in-body', { status: 500 }),
  )
  const provider = createLiveEmbeddingProvider(config)

  let error: unknown
  try {
    await provider.embed(['x'])
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(EmbeddingProviderError)
  expect((error as EmbeddingProviderError).reason).toBe('http_status')
  expect((error as EmbeddingProviderError).status).toBe(500)
  expect((error as EmbeddingProviderError).retryable).toBe(true)
  expect((error as Error).message).toContain('status=500')
  expect((error as Error).message).not.toContain('sk-leaked-in-body')
  // 5xx 属"重发有意义"：恰好重试到上限，一次不多一次不少。
  expect(captured).toHaveLength(EMBEDDING_MAX_ATTEMPTS)
})

test('429 会重试，第 2 次成功即返回；4xx 参数错误只请求一次（重发不会变好）', async () => {
  const retried = stubFetch((_captured, index) =>
    index === 0
      ? new Response('rate limited', { status: 429 })
      : jsonResponse({ data: [{ embedding: vectorOf(0.5) }] }),
  )
  const provider = createLiveEmbeddingProvider(config)
  expect(await provider.embed(['x'])).toEqual([vectorOf(0.5)])
  expect(retried).toHaveLength(2)

  const rejected = stubFetch(() => new Response('bad request', { status: 400 }))
  let error: unknown
  try {
    await createLiveEmbeddingProvider(config).embed(['x'])
  } catch (caught) {
    error = caught
  }
  expect((error as EmbeddingProviderError).reason).toBe('http_status')
  expect((error as EmbeddingProviderError).status).toBe(400)
  expect((error as EmbeddingProviderError).retryable).toBe(false)
  expect(rejected).toHaveLength(1)
})

test('超时与网络错误分别归类，并重试到次数上限（有界，不会无限重发）', async () => {
  const captured = stubFetch(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  const timeoutProvider = createLiveEmbeddingProvider(config)

  let timeoutError: unknown
  try {
    await timeoutProvider.embed(['x'])
  } catch (caught) {
    timeoutError = caught
  }
  expect((timeoutError as EmbeddingProviderError).reason).toBe('timeout')
  expect((timeoutError as Error).message).toContain(`${EMBEDDING_TIMEOUT_MS}ms`)
  expect((timeoutError as EmbeddingProviderError).retryable).toBe(true)
  expect(captured).toHaveLength(EMBEDDING_MAX_ATTEMPTS)

  const networkCaptured = stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  const networkProvider = createLiveEmbeddingProvider(config)
  let networkError: unknown
  try {
    await networkProvider.embed(['x'])
  } catch (caught) {
    networkError = caught
  }
  expect((networkError as EmbeddingProviderError).reason).toBe('network')
  expect(networkCaptured).toHaveLength(EMBEDDING_MAX_ATTEMPTS)
})

test('响应不是合法 JSON / 不是对象 / 条数不符都算 invalid_response，且不重试', async () => {
  const cases: (() => Response)[] = [
    () => new Response('not json at all', { status: 200 }),
    () => jsonResponse('just a string'),
    () => jsonResponse({ data: [{ embedding: vectorOf(0.1) }] }), // 期望 2 条只给 1 条
  ]

  for (const makeResponse of cases) {
    const captured = stubFetch(makeResponse)
    const provider = createLiveEmbeddingProvider(config)
    let error: unknown
    try {
      await provider.embed(['a', 'b'])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EmbeddingProviderError)
    expect((error as EmbeddingProviderError).reason).toBe('invalid_response')
    expect((error as EmbeddingProviderError).retryable).toBe(false)
    // 返回形状不对时重发同样会拿到同样的响应，只请求一次。
    expect(captured).toHaveLength(1)
  }
})

test('维度不符与 NaN 各自失败，绝不返回"看起来合法"的向量，且都不重试', async () => {
  const shortCaptured = stubFetch(() => jsonResponse({ data: [{ embedding: [1, 2, 3] }] }))
  const shortProvider = createLiveEmbeddingProvider(config)
  let dimensionError: unknown
  try {
    await shortProvider.embed(['x'])
  } catch (caught) {
    dimensionError = caught
  }
  expect((dimensionError as EmbeddingProviderError).reason).toBe('dimension_mismatch')
  expect((dimensionError as EmbeddingProviderError).retryable).toBe(false)
  expect((dimensionError as Error).message).toContain(`${EMBEDDING_DIMENSIONS}`)
  expect(shortCaptured).toHaveLength(1)

  const nan = vectorOf(0)
  nan[0] = Number.NaN
  const nanCaptured = stubFetch(() => jsonResponse({ data: [{ embedding: nan }] }))
  const nanProvider = createLiveEmbeddingProvider(config)
  let nanError: unknown
  try {
    await nanProvider.embed(['x'])
  } catch (caught) {
    nanError = caught
  }
  expect((nanError as EmbeddingProviderError).reason).toBe('invalid_response')
  expect(nanCaptured).toHaveLength(1)
})
