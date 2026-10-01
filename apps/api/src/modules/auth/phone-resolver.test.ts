import { describe, expect, test } from 'bun:test'
import { createWechatAccessTokenService } from '../wechat/access-token'
import {
  createLivePhoneResolver,
  createStubPhoneResolver,
  MAINLAND_PHONE_PATTERN,
  PhoneResolveError,
} from './phone-resolver'

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token'
const PHONE_URL = 'https://api.weixin.qq.com/wxa/business/getuserphonenumber'

/**
 * 真实 token 服务 + 可控 fetch：凭证链路（缓存 / invalidate）不 mock，
 * 否则「40001 之后会重新取凭证」这条断言就只是自证。
 */
function tokenService(options: { fail?: boolean } = {}) {
  let calls = 0
  const service = createWechatAccessTokenService({
    appid: 'wx-test',
    appSecret: 'secret-test',
    fetchImpl: (async (input: unknown) => {
      calls += 1
      if (options.fail) throw new Error('connect ECONNREFUSED secret-test')
      expect(String(input)).toBe(TOKEN_URL)
      return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 7200 }), {
        status: 200,
      })
    }) as unknown as typeof fetch,
  })
  return { service, tokenCalls: () => calls }
}

/** 记录每次手机号请求的 URL 与 body，响应由调用方给。 */
function phoneFetch(respond: (call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; body: unknown }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return respond(calls.length)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const successBody = (purePhoneNumber = '13800138000') =>
  new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', phone_info: { purePhoneNumber } }), {
    status: 200,
  })

async function failureOf(run: () => Promise<unknown>): Promise<PhoneResolveError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PhoneResolveError) return error
    throw error
  }
  throw new Error('期望抛出 PhoneResolveError，但没有')
}

describe('createStubPhoneResolver（WECHAT_TRANSPORT=stub）', () => {
  test('11 位手机号原样返回（前后空白先 trim）', async () => {
    const resolver = createStubPhoneResolver()
    expect(await resolver.resolve('13800138000')).toBe('13800138000')
    expect(await resolver.resolve('  13800138000  ')).toBe('13800138000')
  })

  test('形状不是 11 位手机号 → code_invalid（不是上游故障）', async () => {
    const resolver = createStubPhoneResolver()
    for (const bad of ['12345', '23800138000', '1380013800', '138001380001', 'abc']) {
      expect(MAINLAND_PHONE_PATTERN.test(bad)).toBe(false)
      expect((await failureOf(() => resolver.resolve(bad))).failure).toBe('code_invalid')
    }
  })
})

describe('createLivePhoneResolver：成功路径', () => {
  test('取回 purePhoneNumber；请求带 access_token 与 code，且不带任何客户端上报的号码字段', async () => {
    const { service } = tokenService()
    const { impl, calls } = phoneFetch(() => successBody())
    const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })

    expect(await resolver.resolve('phone-code-1')).toBe('13800138000')

    expect(calls).toHaveLength(1)
    const first = calls[0]
    if (!first) throw new Error('没有发出手机号请求')
    const { url, body } = first
    expect(`${url.origin}${url.pathname}`).toBe(PHONE_URL)
    expect(url.searchParams.get('access_token')).toBe('tok-1')
    // 冻结项：端上只交 code，body 里不允许出现明文号码 / encryptedData / iv / cloudID。
    expect(body).toEqual({ code: 'phone-code-1' })
  })

  test('凭证复用：两次换取只取一次 access_token', async () => {
    const { service, tokenCalls } = tokenService()
    const { impl } = phoneFetch(() => successBody())
    const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })

    await resolver.resolve('code-a')
    await resolver.resolve('code-b')
    expect(tokenCalls()).toBe(1)
  })
})

describe('createLivePhoneResolver：code 无效（唯一判给用户的分支）', () => {
  for (const errcode of [40029, 40163]) {
    test(`errcode=${errcode} → code_invalid`, async () => {
      const { service } = tokenService()
      const { impl } = phoneFetch(
        () => new Response(JSON.stringify({ errcode, errmsg: 'invalid code' }), { status: 200 }),
      )
      const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })

      expect((await failureOf(() => resolver.resolve('bad-code'))).failure).toBe('code_invalid')
    })
  }
})

describe('createLivePhoneResolver：凭证失效 → 丢缓存 + 上游故障', () => {
  for (const errcode of [40001, 40014, 42001]) {
    test(`errcode=${errcode} 判 upstream_unavailable，且下一次调用会重新取凭证`, async () => {
      const { service, tokenCalls } = tokenService()
      let call = 0
      const { impl } = phoneFetch(() => {
        call += 1
        // 第一次回凭证失效；第二次（拿到新 token 后）成功，用来证明缓存确实被丢了。
        return call === 1
          ? new Response(JSON.stringify({ errcode, errmsg: 'invalid credential' }), { status: 200 })
          : successBody()
      })
      const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })

      expect((await failureOf(() => resolver.resolve('code-1'))).failure).toBe(
        'upstream_unavailable',
      )
      expect(tokenCalls()).toBe(1)

      // 缓存已被 invalidate：第二次换取必须重新取凭证，否则会一直拿着死 token 重试。
      expect(await resolver.resolve('code-2')).toBe('13800138000')
      expect(tokenCalls()).toBe(2)
    })
  }
})

describe('createLivePhoneResolver：平台侧故障 → 一律 upstream_unavailable', () => {
  test('其它 errcode（频控 45011 / 系统繁忙 -1 / 接口未授权 48001）不判成用户错误', async () => {
    for (const errcode of [45011, -1, 48001]) {
      const { service } = tokenService()
      const { impl } = phoneFetch(
        () => new Response(JSON.stringify({ errcode, errmsg: 'busy' }), { status: 200 }),
      )
      const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })
      expect((await failureOf(() => resolver.resolve('code'))).failure).toBe('upstream_unavailable')
    }
  })

  test('HTTP 非 2xx → upstream_unavailable', async () => {
    const { service } = tokenService()
    const { impl } = phoneFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })
    expect((await failureOf(() => resolver.resolve('code'))).failure).toBe('upstream_unavailable')
  })

  test('响应非 JSON → upstream_unavailable，且 message 不带响应原文', async () => {
    const { service } = tokenService()
    const { impl } = phoneFetch(
      () => new Response('gateway says: secret-test / code=leaked', { status: 200 }),
    )
    const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })
    const error = await failureOf(() => resolver.resolve('leaked-code'))
    expect(error.failure).toBe('upstream_unavailable')
    expect(error.message).not.toContain('leaked')
    expect(error.message).not.toContain('secret-test')
  })

  test('缺 phone_info / 号码形状不可入库 → upstream_unavailable', async () => {
    const bodies = [
      { errcode: 0 },
      { errcode: 0, phone_info: null },
      { errcode: 0, phone_info: {} },
      { errcode: 0, phone_info: { purePhoneNumber: '12345' } },
      { errcode: 0, phone_info: { purePhoneNumber: 13800138000 } },
    ]
    for (const payload of bodies) {
      const { service } = tokenService()
      const { impl } = phoneFetch(() => new Response(JSON.stringify(payload), { status: 200 }))
      const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })
      expect((await failureOf(() => resolver.resolve('code'))).failure).toBe('upstream_unavailable')
    }
  })

  test('上游超时 → upstream_unavailable，message 只带错误类型名（不含 access_token）', async () => {
    const { service } = tokenService()
    const impl = (async (_input: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
      return successBody()
    }) as unknown as typeof fetch
    const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl, timeoutMs: 5 })

    const error = await failureOf(() => resolver.resolve('code'))
    expect(error.failure).toBe('upstream_unavailable')
    expect(error.message).toContain('TimeoutError')
    expect(error.message).not.toContain('tok-1')
  })

  test('取凭证失败 → upstream_unavailable（不是用户 code 的问题）', async () => {
    const { service } = tokenService({ fail: true })
    const { impl, calls } = phoneFetch(() => successBody())
    const resolver = createLivePhoneResolver({ tokens: service, fetchImpl: impl })

    const error = await failureOf(() => resolver.resolve('code'))
    expect(error.failure).toBe('upstream_unavailable')
    // 连手机号接口都没打出去。
    expect(calls).toHaveLength(0)
  })
})
