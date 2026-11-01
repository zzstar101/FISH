import { describe, expect, test } from 'bun:test'
import type { WechatAccessTokenService } from '../wechat/access-token'
import {
  createSubscribeMessageClient,
  miniprogramStateOf,
  SUBSCRIBE_ERRCODE_NO_QUOTA,
  SUBSCRIBE_SEND_URL,
} from './client'

/**
 * 订阅消息发送客户端（#462）的 errcode 归类用例。
 *
 * 归类是上游协议的一部分：调度器只消费 `retryable / permanent / no-quota`，
 * 「哪个码属于哪类」写错一处，整条投递的重试语义就错了（比如把 43101 当故障一直重试，
 * 或者在模板 id 写错时无限重试）。
 */

type Call = { url: URL; body: Record<string, unknown> }

function fakeTokens(overrides: Partial<WechatAccessTokenService> = {}): WechatAccessTokenService & {
  invalidated: (string | undefined)[]
  getCalls: number
} {
  const invalidated: (string | undefined)[] = []
  let getCalls = 0
  return {
    invalidated,
    get getCalls() {
      return getCalls
    },
    async get() {
      getCalls += 1
      return `token-${getCalls}`
    },
    invalidate(expectedToken?: string) {
      invalidated.push(expectedToken)
    },
    ...overrides,
  }
}

/** 造一个按顺序回包的 fetch：`responses[i]` 是第 i 次调用的结果（对象=JSON 回包）。 */
function scriptedFetch(responses: (Record<string, unknown> | (() => never))[]) {
  const calls: Call[] = []
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = input instanceof URL ? input : new URL(String(input))
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const next = responses[calls.length - 1]
    if (typeof next === 'function') next()
    return new Response(JSON.stringify(next ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const input = {
  openid: 'o-openid-28-chars-xxxxxxxxxxx',
  templateId: 'tmpl_chat',
  page: 'pkg-social/pages/conversation/index?id=cnv_x',
  data: { thing4: '林一' },
}

describe('miniprogramStateOf', () => {
  test('WECHAT_QR_ENV_VERSION → miniprogram_state', () => {
    expect(miniprogramStateOf('develop')).toBe('developer')
    expect(miniprogramStateOf('trial')).toBe('trial')
    // release 是默认值，映射成 formal
    expect(miniprogramStateOf('release')).toBe('formal')
  })
})

describe('createSubscribeMessageClient.send', () => {
  test('errcode 0 → ok，并且按契约拼请求体', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ errcode: 0, errmsg: 'ok' }])
    const client = createSubscribeMessageClient({
      tokens: fakeTokens(),
      miniprogramState: 'formal',
      fetchImpl,
    })

    expect(await client.send(input)).toEqual({ ok: true })
    const call = calls[0]
    if (!call) throw new Error('没有发出请求')
    expect(call.url.origin + call.url.pathname).toBe(SUBSCRIBE_SEND_URL)
    expect(call.url.searchParams.get('access_token')).toBe('token-1')
    expect(call.body).toEqual({
      touser: input.openid,
      template_id: input.templateId,
      page: input.page,
      data: input.data,
      miniprogram_state: 'formal',
      lang: 'zh_CN',
    })
  })

  test('43101 → no-quota（不重试，由调用方把本地计数置 0）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { errcode: SUBSCRIBE_ERRCODE_NO_QUOTA, errmsg: 'user refuse to accept the msg' },
    ])
    const client = createSubscribeMessageClient({
      tokens: fakeTokens(),
      miniprogramState: 'formal',
      fetchImpl,
    })

    expect(await client.send(input)).toEqual({
      ok: false,
      reason: 'no-quota',
      errcode: 43101,
      detail: 'errcode=43101',
    })
    expect(calls).toHaveLength(1)
  })

  test.each([40003, 40037, 41030, 47003])(
    '参数类 errcode %d → permanent（不重试）',
    async (errcode) => {
      const { fetchImpl, calls } = scriptedFetch([{ errcode }])
      const client = createSubscribeMessageClient({
        tokens: fakeTokens(),
        miniprogramState: 'formal',
        fetchImpl,
      })

      expect(await client.send(input)).toMatchObject({ ok: false, reason: 'permanent', errcode })
      expect(calls).toHaveLength(1)
    },
  )

  test('-1（系统繁忙）与未知 errcode 都是 retryable', async () => {
    for (const errcode of [-1, 45009, 45011]) {
      const { fetchImpl } = scriptedFetch([{ errcode }])
      const client = createSubscribeMessageClient({
        tokens: fakeTokens(),
        miniprogramState: 'formal',
        fetchImpl,
      })
      expect(await client.send(input)).toMatchObject({ ok: false, reason: 'retryable', errcode })
    }
  })

  test('凭证失效（40001）→ invalidate 后重取一次并重试成功', async () => {
    const tokens = fakeTokens()
    const { fetchImpl, calls } = scriptedFetch([{ errcode: 40001 }, { errcode: 0 }])
    const client = createSubscribeMessageClient({
      tokens,
      miniprogramState: 'formal',
      fetchImpl,
    })

    expect(await client.send(input)).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    // 只清就是它自己那一份（并发下别的请求可能已经换好了新 token）
    expect(tokens.invalidated).toEqual(['token-1'])
    // 第二次用的是重取到的 token
    expect(calls[1]?.url.searchParams.get('access_token')).toBe('token-2')
  })

  test('42001 / 40014 同属凭证失效', async () => {
    for (const errcode of [42001, 40014]) {
      const tokens = fakeTokens()
      const { fetchImpl } = scriptedFetch([{ errcode }, { errcode: 0 }])
      const client = createSubscribeMessageClient({
        tokens,
        miniprogramState: 'formal',
        fetchImpl,
      })
      expect(await client.send(input)).toEqual({ ok: true })
      expect(tokens.invalidated).toHaveLength(1)
    }
  })

  test('换过凭证仍失效 → retryable（退避后再来，不无限重试）', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ errcode: 40001 }, { errcode: 40001 }])
    const client = createSubscribeMessageClient({
      tokens: fakeTokens(),
      miniprogramState: 'formal',
      fetchImpl,
    })

    expect(await client.send(input)).toMatchObject({
      ok: false,
      reason: 'retryable',
      errcode: 40001,
    })
    expect(calls).toHaveLength(2)
  })

  test('取凭证失败 → retryable（不是这条消息的错）', async () => {
    const tokens = fakeTokens({
      async get() {
        throw new Error('stable_token HTTP 502')
      },
    })
    const { fetchImpl, calls } = scriptedFetch([{ errcode: 0 }])
    const client = createSubscribeMessageClient({
      tokens,
      miniprogramState: 'formal',
      fetchImpl,
    })

    expect(await client.send(input)).toEqual({
      ok: false,
      reason: 'retryable',
      detail: 'token-unavailable',
    })
    expect(calls).toHaveLength(0)
  })

  test('网络异常 / 超时 → retryable，详情只带错误类型名（不泄漏含 token 的 URL）', async () => {
    const tokens = fakeTokens()
    const failing = (async () => {
      const error = new Error(`request to ${SUBSCRIBE_SEND_URL}?access_token=token-1 failed`)
      error.name = 'TimeoutError'
      throw error
    }) as unknown as typeof fetch
    const client = createSubscribeMessageClient({
      tokens,
      miniprogramState: 'formal',
      fetchImpl: failing,
    })

    const outcome = await client.send(input)
    expect(outcome).toEqual({ ok: false, reason: 'retryable', detail: 'fetch-TimeoutError' })
    expect(JSON.stringify(outcome)).not.toContain('access_token')
  })

  test('5xx → retryable', async () => {
    const responses = [new Response('boom', { status: 502 })]
    const fetchImpl = (async () =>
      responses.shift() ?? new Response('boom', { status: 502 })) as unknown as typeof fetch
    const client = createSubscribeMessageClient({
      tokens: fakeTokens(),
      miniprogramState: 'formal',
      fetchImpl,
    })

    expect(await client.send(input)).toEqual({ ok: false, reason: 'retryable', detail: 'http-502' })
  })

  test('非 JSON / 缺 errcode → retryable（不把畸形响应当成功）', async () => {
    for (const payload of ['not-json', '{"errmsg":"ok"}', '{"errcode":"0"}']) {
      const fetchImpl = (async () =>
        new Response(payload, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch
      const client = createSubscribeMessageClient({
        tokens: fakeTokens(),
        miniprogramState: 'formal',
        fetchImpl,
      })
      expect(await client.send(input)).toMatchObject({ ok: false, reason: 'retryable' })
    }
  })
})
