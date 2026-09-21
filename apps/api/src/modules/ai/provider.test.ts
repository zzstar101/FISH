import { describe, expect, test } from 'bun:test'
import type { AiPolishEnv } from '@fish/shared/env'
import { AiUpstreamError, createPolishProvider } from './provider'

type FetchCall = { url: string; init: RequestInit }

const STUB_ENV: AiPolishEnv = { transport: 'stub', baseUrl: 'http://stub.local/' }
const LIVE_ENV: AiPolishEnv = {
  transport: 'live',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-not-a-real-key',
  model: 'deepseek-flash',
}

const PROMPT = { system: 'system 提示词', user: 'user 提示词' }

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 与 auth/router.test.ts 的 Resend 用例同一套打桩/还原惯用写法。 */
async function runWithFetch(
  respond: (call: FetchCall, index: number) => Response | Promise<Response>,
  body: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {} }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as unknown as typeof fetch
  try {
    await body(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function captureError(run: () => Promise<unknown>): Promise<AiUpstreamError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiUpstreamError) return error
    throw error
  }
  throw new Error('预期抛 AiUpstreamError，但没有抛错')
}

function completion(content: string, extra: Record<string, unknown> = {}): unknown {
  return { choices: [{ message: { content }, finish_reason: 'stop' }], usage: {}, ...extra }
}

describe('上游调用', () => {
  test('请求形状：端点、鉴权头、参数常量、超时 signal', async () => {
    await runWithFetch(
      () => jsonResponse(completion('一条候选')),
      async (calls) => {
        await createPolishProvider(STUB_ENV).complete(PROMPT)

        const call = calls[0]
        expect(call?.url).toBe('http://stub.local/chat/completions')
        const headers = call?.init.headers as Record<string, string>
        expect(headers['content-type']).toBe('application/json')
        // stub 不带上游密钥：本地假模型服务不需要，也不该看到它。
        expect(headers.authorization).toBeUndefined()

        const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>
        expect(body.model).toBe('stub')
        expect(body.messages).toEqual([
          { role: 'system', content: PROMPT.system },
          { role: 'user', content: PROMPT.user },
        ])
        expect(body.max_tokens).toBe(2000)
        expect(body.temperature).toBe(0.7)
        expect(body.thinking).toEqual({ type: 'disabled' })
        expect(call?.init.signal).toBeInstanceOf(AbortSignal)
      },
    )
  })

  test('live 带 Bearer 与配置里的 model', async () => {
    await runWithFetch(
      () => jsonResponse(completion('一条候选')),
      async (calls) => {
        const provider = createPolishProvider(LIVE_ENV)
        expect(provider.name).toBe('live')
        await provider.complete(PROMPT)

        const headers = calls[0]?.init.headers as Record<string, string>
        expect(headers.authorization).toBe('Bearer sk-not-a-real-key')
        expect(JSON.parse(String(calls[0]?.init.body)).model).toBe('deepseek-flash')
      },
    )
  })

  test('=== 分段、剔除空段、最多取 3 条，并解析 usage', async () => {
    const content = '第一条\n===\n\n===\n第二条\n===\n第三条\n===\n第四条'
    await runWithFetch(
      () =>
        jsonResponse({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 258 },
        }),
      async () => {
        const result = await createPolishProvider(STUB_ENV).complete(PROMPT)
        expect(result.segments).toEqual(['第一条', '第二条', '第三条'])
        expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 258 })
      },
    )
  })

  test('超时与网络错误分开记，都不重试', async () => {
    await runWithFetch(
      () => {
        const error = new Error('The operation was aborted due to timeout')
        error.name = 'TimeoutError'
        throw error
      },
      async (calls) => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('timeout')
        expect(calls).toHaveLength(1)
      },
    )

    await runWithFetch(
      () => {
        throw new TypeError('fetch failed')
      },
      async (calls) => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('network')
        expect(calls).toHaveLength(1)
      },
    )
  })

  test('4xx/5xx 只记状态码，不把上游响应体带进错误消息', async () => {
    const leak = '内部错误：用户写的 13812345678 无法处理'
    await runWithFetch(
      () => new Response(leak, { status: 500 }),
      async (calls) => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('http_status')
        expect(error.status).toBe(500)
        // 上游响应文本不可信：可能回显用户原文，绝不能进错误消息（日志与响应都会带上它）。
        expect(error.message).not.toContain(leak)
        expect(error.message).not.toContain('13812345678')
        // 不重试：重试会让"失败扣不扣配额"难以解释（设计 §5.4）。
        expect(calls).toHaveLength(1)
      },
    )
  })

  test('空正文与"想完了没写"（finish_reason=length）分开判定', async () => {
    await runWithFetch(
      () => jsonResponse({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }),
      async () => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('empty_content')
      },
    )

    await runWithFetch(
      () => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
      async () => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('truncated')
      },
    )
  })

  test('响应形状不符（缺 choices、非 JSON）都算上游违约', async () => {
    await runWithFetch(
      () => jsonResponse({ choices: [] }),
      async () => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('bad_payload')
      },
    )

    await runWithFetch(
      () => new Response('not json at all', { status: 200 }),
      async () => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('bad_payload')
        expect(error.message).not.toContain('not json at all')
      },
    )
  })

  test('body 读取被 8s signal 中止也算超时，不混成上游违约', async () => {
    const aborted = new Error('The operation was aborted due to timeout')
    aborted.name = 'TimeoutError'

    await runWithFetch(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw aborted
          },
        }) as unknown as Response,
      async () => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('timeout')
      },
    )
  })

  test('只有分隔线没有正文时算上游违约，不是 EMPTY', async () => {
    await runWithFetch(
      () => jsonResponse(completion('===\n===\n')),
      async () => {
        const error = await captureError(() => createPolishProvider(STUB_ENV).complete(PROMPT))
        expect(error.reason).toBe('no_segments')
      },
    )
  })
})
