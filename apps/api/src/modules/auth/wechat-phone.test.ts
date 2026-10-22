import { describe, expect, test } from 'bun:test'
import type { WechatAccessTokenService } from '../wechat/access-token'
import { WechatPlatformError } from '../wechat/access-token'
import {
  createWechatPhoneClient,
  PhoneCodeInvalidError,
  PhoneNumberUnsupportedError,
} from './wechat-phone'

const PHONE_URL = 'https://api.weixin.qq.com/wxa/business/getuserphonenumber'

/** 记录 `invalidate` 调用的假 token 服务：序列里每项是下一次 `get()` 的返回值。 */
function fakeTokens(tokens: string[]) {
  const issued: string[] = []
  const invalidated: Array<string | undefined> = []
  const service: WechatAccessTokenService = {
    async get() {
      const token = tokens[Math.min(issued.length, tokens.length - 1)] ?? ''
      issued.push(token)
      return token
    },
    invalidate(expectedToken?: string) {
      invalidated.push(expectedToken)
    },
  }
  return { service, issued, invalidated }
}

function stubFetch(handler: (url: URL, init: RequestInit | undefined) => Response) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input.href : String(input))
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const okBody = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      errcode: 0,
      errmsg: 'ok',
      phone_info: {
        phoneNumber: '19912345678',
        purePhoneNumber: '19912345678',
        countryCode: '86',
        watermark: { timestamp: 1700000000, appid: 'wx-test' },
      },
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('createWechatPhoneClient（#204：live 手机号换取）', () => {
  test('成功：用 access_token 换号，code 走请求体而不是 URL', async () => {
    const { service } = fakeTokens(['tok-1'])
    const { fetchImpl, calls } = stubFetch(() => okBody())
    const client = createWechatPhoneClient({ tokens: service, fetchImpl })

    expect(await client.resolve('phone-code-abc')).toBe('19912345678')
    expect(calls).toHaveLength(1)
    const sent = calls[0]
    if (sent === undefined) throw new Error('上游没有被调用')
    expect(`${sent.url.origin}${sent.url.pathname}`).toBe(PHONE_URL)
    expect(sent.url.searchParams.get('access_token')).toBe('tok-1')
    // code 是敏感值：必须只在请求体里，不进 URL（URL 会进日志 / 代理记录）。
    expect(sent.url.toString()).not.toContain('phone-code-abc')
    expect(JSON.parse(sent.init?.body as string)).toEqual({ code: 'phone-code-abc' })
  })

  test('号码字段：缺 purePhoneNumber 时退回 phoneNumber，两者都不是大陆号才判不支持', async () => {
    const { service } = fakeTokens(['tok-1'])

    const onlyFull = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            errcode: 0,
            phone_info: { phoneNumber: '13800138000', countryCode: '86' },
          }),
          { status: 200 },
        ),
    )
    expect(
      await createWechatPhoneClient({ tokens: service, fetchImpl: onlyFull.fetchImpl }).resolve(
        'c',
      ),
    ).toBe('13800138000')

    const overseas = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            errcode: 0,
            phone_info: {
              phoneNumber: '+85261234567',
              purePhoneNumber: '61234567',
              countryCode: '852',
            },
          }),
          { status: 200 },
        ),
    )
    await expect(
      createWechatPhoneClient({ tokens: service, fetchImpl: overseas.fetchImpl }).resolve('c'),
    ).rejects.toBeInstanceOf(PhoneNumberUnsupportedError)
  })

  test('号码带国家码前缀：剥掉 +86 后仍按大陆号接受，不误判成「不支持」', async () => {
    const { service } = fakeTokens(['tok-1'])
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ errcode: 0, phone_info: { phoneNumber: '+8613800138000' } }),
          { status: 200 },
        ),
    )
    expect(await createWechatPhoneClient({ tokens: service, fetchImpl }).resolve('c')).toBe(
      '13800138000',
    )
  })

  test('国家码不是 86：即使号码形态像大陆号也判不支持；缺 countryCode 时退回形态判断', async () => {
    const { service } = fakeTokens(['tok-1'])

    // +1 的 11 位号码形态与大陆号一致，必须靠 countryCode 拦住。
    const usNumber = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            errcode: 0,
            phone_info: { phoneNumber: '19912345678', countryCode: '1' },
          }),
          { status: 200 },
        ),
    )
    await expect(
      createWechatPhoneClient({ tokens: service, fetchImpl: usNumber.fetchImpl }).resolve('c'),
    ).rejects.toBeInstanceOf(PhoneNumberUnsupportedError)

    // 上游没给 countryCode 时不因此拒绝：形态通过即接受。
    const noCountry = stubFetch(
      () =>
        new Response(
          JSON.stringify({ errcode: 0, phone_info: { purePhoneNumber: '19912345678' } }),
          { status: 200 },
        ),
    )
    expect(
      await createWechatPhoneClient({ tokens: service, fetchImpl: noCountry.fetchImpl }).resolve(
        'c',
      ),
    ).toBe('19912345678')
  })

  test('取 token 就失败（上游不可达 / 退避窗口内）：直接上抛上游故障，不发换号请求', async () => {
    const failing: WechatAccessTokenService = {
      async get() {
        throw new WechatPlatformError('stable_token 请求失败（TimeoutError）')
      },
      invalidate() {},
    }
    const { fetchImpl, calls } = stubFetch(() => okBody())
    await expect(
      createWechatPhoneClient({ tokens: failing, fetchImpl }).resolve('c'),
    ).rejects.toBeInstanceOf(WechatPlatformError)
    // 没有凭证就不该白打一次计费接口。
    expect(calls).toHaveLength(0)
  })

  test('code 无效 / 已用：抛 PhoneCodeInvalidError，且不重试（上游只被打一次）', async () => {
    for (const errcode of [40029, 40163]) {
      const { service, invalidated } = fakeTokens(['tok-1'])
      const { fetchImpl, calls } = stubFetch(
        () => new Response(JSON.stringify({ errcode, errmsg: 'invalid code' }), { status: 200 }),
      )
      await expect(
        createWechatPhoneClient({ tokens: service, fetchImpl }).resolve('c'),
      ).rejects.toBeInstanceOf(PhoneCodeInvalidError)
      expect(calls).toHaveLength(1)
      // code 的问题不是 token 的问题：不许把有效凭证丢掉。
      expect(invalidated).toHaveLength(0)
    }
  })

  test('凭证失效（42001）：invalidate 旧 token 后换新 token 重试一次成功', async () => {
    const { service, invalidated } = fakeTokens(['tok-old', 'tok-new'])
    let call = 0
    const { fetchImpl, calls } = stubFetch(() => {
      call += 1
      return call === 1
        ? new Response(JSON.stringify({ errcode: 42001, errmsg: 'token expired' }), { status: 200 })
        : okBody()
    })

    expect(await createWechatPhoneClient({ tokens: service, fetchImpl }).resolve('c')).toBe(
      '19912345678',
    )
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url.searchParams.get('access_token')).toBe('tok-new')
    // 必须只清「就是它」的那份缓存，否则并发下会误清别人刚刷出来的新 token。
    expect(invalidated).toEqual(['tok-old'])
  })

  test('凭证失效两次：重试只用一次，仍失败则抛上游故障（不无限重试烧计费调用）', async () => {
    const { service } = fakeTokens(['tok-old', 'tok-new'])
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ errcode: 40001 }), { status: 200 }),
    )
    await expect(
      createWechatPhoneClient({ tokens: service, fetchImpl }).resolve('c'),
    ).rejects.toBeInstanceOf(WechatPlatformError)
    expect(calls).toHaveLength(2)
  })

  test('超时 / 网络失败：抛上游故障，且错误信息里不带 access_token 与 code', async () => {
    const { service } = fakeTokens(['tok-secret'])
    const fetchImpl = (async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }) as unknown as typeof fetch

    const error = await createWechatPhoneClient({ tokens: service, fetchImpl })
      .resolve('code-secret')
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WechatPlatformError)
    const message = (error as Error).message
    expect(message).toContain('TimeoutError')
    expect(message).not.toContain('tok-secret')
    expect(message).not.toContain('code-secret')
  })

  test('上游异常响应：HTTP 非 2xx、非 JSON、errcode 非法、缺 phone_info 一律算上游故障', async () => {
    const { service } = fakeTokens(['tok-1'])
    const cases: Array<() => Response> = [
      () => new Response('boom', { status: 500 }),
      () => new Response('not-json', { status: 200 }),
      () => new Response(JSON.stringify({ errcode: '45011' }), { status: 200 }),
      () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 }),
      // phone_info 在、但号码字段缺失 / 空串 / 非字符串：上游契约被破坏，不是「号码不支持」。
      () => new Response(JSON.stringify({ errcode: 0, phone_info: {} }), { status: 200 }),
      () =>
        new Response(JSON.stringify({ errcode: 0, phone_info: { purePhoneNumber: '' } }), {
          status: 200,
        }),
      () =>
        new Response(JSON.stringify({ errcode: 0, phone_info: { purePhoneNumber: 123 } }), {
          status: 200,
        }),
    ]
    for (const handler of cases) {
      await expect(
        createWechatPhoneClient({
          tokens: service,
          fetchImpl: stubFetch(handler).fetchImpl,
        }).resolve('c'),
      ).rejects.toBeInstanceOf(WechatPlatformError)
    }
  })

  test('频率限制 45011 不算 code 无效：它是上游故障，用户重试没用', async () => {
    const { service } = fakeTokens(['tok-1'])
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ errcode: 45011 }), { status: 200 }),
    )
    const error = await createWechatPhoneClient({ tokens: service, fetchImpl })
      .resolve('c')
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WechatPlatformError)
    expect((error as WechatPlatformError).errcode).toBe(45011)
  })
})
