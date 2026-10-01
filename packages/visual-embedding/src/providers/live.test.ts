import { afterEach, expect, test } from 'bun:test'
import { EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'
import {
  createLiveVisualEmbeddingProvider,
  MULTIMODAL_EMBEDDING_PATH,
  VISUAL_EMBEDDING_MAX_ATTEMPTS,
  VISUAL_EMBEDDING_RETRY_BASE_DELAY_MS,
  VISUAL_EMBEDDING_TIMEOUT_MS,
} from './live'

/**
 * live provider 的单测：**不出网**，用假 fetch 钉住请求形状、失败分类与重试次数上限。
 * 真实密钥的 live smoke 是另一件事，这里只保证实现存在且 fail-closed。
 */
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const config = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-not-a-real-key',
  model: 'qwen3-vl-embedding',
  // 退避压到 0：这里验证的是"重试几次"，不是"等多久"，不真等就不会拖慢测试。
  retryDelayMs: 0,
}

const ENDPOINT = `https://api.example.com/v1${MULTIMODAL_EMBEDDING_PATH}`

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 250, 251, 252])

function vectorOf(value: number): number[] {
  return new Array<number>(VISUAL_EMBEDDING_DIMENSIONS).fill(value)
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

type EmbeddingBody = {
  model: string
  input: { contents: { image?: string; text?: string }[] }
  parameters: { dimension: number }
}

function bodyOf(request: Captured | undefined): EmbeddingBody {
  return JSON.parse(String(request?.init?.body)) as EmbeddingBody
}

/** 断言调用必然拒绝，并把错误收窄成 `EmbeddingProviderError`（测试内避免裸 cast）。 */
async function captureError(run: () => Promise<unknown>): Promise<EmbeddingProviderError> {
  try {
    await run()
  } catch (caught) {
    if (caught instanceof EmbeddingProviderError) return caught
    throw caught
  }
  throw new Error('expected the call to reject, but it resolved')
}

test('embedImage：POST 到 DashScope 原生路径，Bearer + JSON，图片编成 data URI', async () => {
  const captured = stubFetch(() =>
    jsonResponse({ output: { embeddings: [{ embedding: vectorOf(0.5) }] } }),
  )
  const provider = createLiveVisualEmbeddingProvider(config)

  const vector = await provider.embedImage(IMAGE_BYTES, 'image/png')

  expect(provider.model).toBe('qwen3-vl-embedding')
  expect(provider.dimensions).toBe(VISUAL_EMBEDDING_DIMENSIONS)
  expect(vector).toEqual(vectorOf(0.5))

  const request = captured[0]
  expect(request?.url).toBe(ENDPOINT)
  expect(request?.init?.method).toBe('POST')
  const headers = request?.init?.headers as Record<string, string> | undefined
  expect(headers?.authorization).toBe('Bearer sk-not-a-real-key')
  expect(headers?.['content-type']).toBe('application/json')
  // 超时必须显式挂在请求上，否则一个卡住的上游会占满整个请求预算。
  expect(request?.init?.signal).toBeInstanceOf(AbortSignal)

  const body = bodyOf(request)
  expect(body.model).toBe('qwen3-vl-embedding')
  expect(body.input.contents[0]?.image).toBe(
    `data:image/png;base64,${Buffer.from(IMAGE_BYTES).toString('base64')}`,
  )
  expect(body.parameters.dimension).toBe(VISUAL_EMBEDDING_DIMENSIONS)
})

test('embedText：body 只带 text，不带 image 键', async () => {
  const captured = stubFetch(() =>
    jsonResponse({ output: { embeddings: [{ embedding: vectorOf(0.25) }] } }),
  )
  const provider = createLiveVisualEmbeddingProvider(config)

  expect(await provider.embedText('红色球鞋')).toEqual(vectorOf(0.25))

  const body = bodyOf(captured[0])
  expect(body.input.contents).toHaveLength(1)
  // toEqual 是精确比较：多出 image 键就会失败。
  expect(body.input.contents[0]).toEqual({ text: '红色球鞋' })
})

test('两种响应信封都能解析：DashScope output.embeddings 与 OpenAI 风格 data', async () => {
  const payloads = [
    { output: { embeddings: [{ embedding: vectorOf(0.5) }] } },
    { data: [{ embedding: vectorOf(0.5) }] },
  ]

  for (const payload of payloads) {
    stubFetch(() => jsonResponse(payload))
    const provider = createLiveVisualEmbeddingProvider(config)
    expect(await provider.embedText('x')).toEqual(vectorOf(0.5))
  }
})

test('维度不符抛 dimension_mismatch 且不重试（重发不会变好）', async () => {
  const captured = stubFetch(() =>
    jsonResponse({ data: [{ embedding: [1, 2, 3, 4, 5, 6, 7, 8] }] }),
  )
  const provider = createLiveVisualEmbeddingProvider(config)

  const error = await captureError(() => provider.embedImage(IMAGE_BYTES, 'image/png'))

  expect(error.reason).toBe('dimension_mismatch')
  expect(error.retryable).toBe(false)
  expect(error.message).toContain(String(VISUAL_EMBEDDING_DIMENSIONS))
  expect(captured).toHaveLength(1)
})

test('非有限数值 / 缺失 embedding 都算 invalid_response 且不重试', async () => {
  const withNull: (number | null)[] = vectorOf(0)
  withNull[0] = null
  const payloads: unknown[] = [
    { data: [{ embedding: withNull }] }, // JSON 里的 null（NaN 序列化后也是它）
    { data: [{}] }, // 缺 embedding 字段
  ]

  for (const payload of payloads) {
    const captured = stubFetch(() => jsonResponse(payload))
    const provider = createLiveVisualEmbeddingProvider(config)

    const error = await captureError(() => provider.embedText('x'))

    expect(error.reason).toBe('invalid_response')
    expect(error.retryable).toBe(false)
    expect(captured).toHaveLength(1)
  }
})

test('429 与 5xx 重试到次数上限，随后以 http_status 失败', async () => {
  for (const status of [429, 500]) {
    const captured = stubFetch(() => new Response('upstream failure', { status }))
    const provider = createLiveVisualEmbeddingProvider(config)

    const error = await captureError(() => provider.embedText('x'))

    expect(error.reason).toBe('http_status')
    expect(error.status).toBe(status)
    expect(error.retryable).toBe(true)
    // 恰好重试到上限，一次不多一次不少（有界重试）。
    expect(captured).toHaveLength(VISUAL_EMBEDDING_MAX_ATTEMPTS)
  }
})

test('400 是请求本身的问题：只请求一次且 retryable 为 false', async () => {
  const captured = stubFetch(() => new Response('bad request', { status: 400 }))
  const provider = createLiveVisualEmbeddingProvider(config)

  const error = await captureError(() => provider.embedText('x'))

  expect(error.reason).toBe('http_status')
  expect(error.status).toBe(400)
  expect(error.retryable).toBe(false)
  expect(captured).toHaveLength(1)
})

test('超时与网络错误分别归类，并重试到次数上限（有界，不会无限重发）', async () => {
  const timeoutCaptured = stubFetch(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  const timeoutError = await captureError(() =>
    createLiveVisualEmbeddingProvider(config).embedText('x'),
  )
  expect(timeoutError.reason).toBe('timeout')
  expect(timeoutError.retryable).toBe(true)
  expect(timeoutError.message).toContain(`${VISUAL_EMBEDDING_TIMEOUT_MS}ms`)
  expect(timeoutCaptured).toHaveLength(VISUAL_EMBEDDING_MAX_ATTEMPTS)

  const networkCaptured = stubFetch(() => {
    throw new TypeError('fetch failed')
  })
  const networkError = await captureError(() =>
    createLiveVisualEmbeddingProvider(config).embedText('x'),
  )
  expect(networkError.reason).toBe('network')
  expect(networkError.retryable).toBe(true)
  expect(networkCaptured).toHaveLength(VISUAL_EMBEDDING_MAX_ATTEMPTS)
})

test('错误消息不回显上游响应体，也不含图片 base64', async () => {
  const captured = stubFetch(() => new Response('SENTINEL-UPSTREAM-BODY', { status: 500 }))
  const provider = createLiveVisualEmbeddingProvider(config)

  const error = await captureError(() => provider.embedImage(IMAGE_BYTES, 'image/png'))

  expect(error.message).toContain('status=500')
  expect(error.message).not.toContain('SENTINEL-UPSTREAM-BODY')
  expect(error.message).not.toContain(Buffer.from(IMAGE_BYTES).toString('base64'))
  expect(captured).toHaveLength(VISUAL_EMBEDDING_MAX_ATTEMPTS)
})

test('重试策略常量存在且为正', () => {
  expect(VISUAL_EMBEDDING_TIMEOUT_MS).toBeGreaterThan(0)
  expect(VISUAL_EMBEDDING_MAX_ATTEMPTS).toBeGreaterThan(0)
  expect(VISUAL_EMBEDDING_RETRY_BASE_DELAY_MS).toBeGreaterThan(0)
})
