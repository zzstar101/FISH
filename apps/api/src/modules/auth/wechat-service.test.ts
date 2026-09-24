import { describe, expect, test } from 'bun:test'
import {
  createLiveWechatIdentityProvider,
  WECHAT_EXCHANGE_TIMEOUT_MS,
  WechatExchangeError,
} from './wechat-service'

/**
 * live `jscode2session` 的边界（#86 评审 P2-1）。
 *
 * 这里用全局 fetch 打桩，因为真实实现把 URL 写死成 `api.weixin.qq.com`。
 * 目的不是验证微信的协议（那需要真实凭证，无法在 CI 覆盖），而是锁住三件本地能保证的事：
 * 1. 出参只依赖上游响应，请求参数按微信要求拼；
 * 2. **必须带超时信号**——上游挂死不能把请求永远挂着；
 * 3. 上游失败只透出错误类型名，绝不把异常原文（可能含带 secret 的 URL）带出去。
 */
const APPID = 'wxtestappid0000001'
const APP_SECRET = '0123456789abcdef0123456789abcdef'
const CODE = 'the-one-time-code'

describe('createLiveWechatIdentityProvider（jscode2session 边界）', () => {
  const originalFetch = globalThis.fetch

  /** 替换全局 fetch，记录每次调用的 URL 与 init。 */
  function stubFetch(handler: (url: URL, init: RequestInit | undefined) => Response) {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(input instanceof URL ? input.href : String(input))
      calls.push({ url, init })
      return handler(url, init)
    }) as unknown as typeof fetch
    return calls
  }

  function restore() {
    globalThis.fetch = originalFetch
  }

  test('请求参数按微信要求拼，并返回 openid / unionid', async () => {
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ openid: 'o1234567890123456789012345', unionid: 'union-1' }), {
          status: 200,
        }),
    )
    try {
      const provider = createLiveWechatIdentityProvider({ appid: APPID, appSecret: APP_SECRET })
      const identity = await provider.exchange(CODE)

      expect(identity).toEqual({ openid: 'o1234567890123456789012345', unionid: 'union-1' })
      expect(calls).toHaveLength(1)
      const call = calls[0]
      expect(call?.url.origin).toBe('https://api.weixin.qq.com')
      expect(call?.url.pathname).toBe('/sns/jscode2session')
      expect(call?.url.searchParams.get('appid')).toBe(APPID)
      expect(call?.url.searchParams.get('secret')).toBe(APP_SECRET)
      expect(call?.url.searchParams.get('js_code')).toBe(CODE)
      expect(call?.url.searchParams.get('grant_type')).toBe('authorization_code')
    } finally {
      restore()
    }
  })

  test('unionid 缺失时回落为 null（主体未绑定开放平台）', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ openid: 'oabcdefghij0123456789abcdefg' }), { status: 200 }),
    )
    try {
      const provider = createLiveWechatIdentityProvider({ appid: APPID, appSecret: APP_SECRET })
      expect(await provider.exchange(CODE)).toEqual({
        openid: 'oabcdefghij0123456789abcdefg',
        unionid: null,
      })
    } finally {
      restore()
    }
  })

  test('带超时信号：上游挂死时请求会自己失败，而不是永远挂着', async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify({ openid: 'o1234567890123456789012345' }), { status: 200 }),
    )
    try {
      const provider = createLiveWechatIdentityProvider({ appid: APPID, appSecret: APP_SECRET })
      await provider.exchange(CODE)

      const signal = calls[0]?.init?.signal
      expect(signal).toBeInstanceOf(AbortSignal)
      // 还没到超时时间，信号不该是已中止状态
      expect(signal?.aborted).toBe(false)
      expect(WECHAT_EXCHANGE_TIMEOUT_MS).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test('超时 / 网络失败 → WechatExchangeError，且错误信息不含 AppSecret', async () => {
    stubFetch(() => {
      const error = new Error(
        `fetch failed for https://api.weixin.qq.com/sns/jscode2session?secret=${APP_SECRET}`,
      )
      error.name = 'TimeoutError'
      throw error
    })
    try {
      const provider = createLiveWechatIdentityProvider({ appid: APPID, appSecret: APP_SECRET })
      let caught: unknown
      try {
        await provider.exchange(CODE)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(WechatExchangeError)
      // 只带错误类型名：原文可能含带 secret 的 URL，绝不透出去
      expect(String(caught)).toContain('TimeoutError')
      expect(String(caught)).not.toContain(APP_SECRET)
    } finally {
      restore()
    }
  })

  test('errcode 非 0（code 无效 / 已用）→ WechatExchangeError 带 errcode', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }), { status: 200 }),
    )
    try {
      const provider = createLiveWechatIdentityProvider({ appid: APPID, appSecret: APP_SECRET })
      await expect(provider.exchange(CODE)).rejects.toThrow('errcode=40029')
    } finally {
      restore()
    }
  })

  test('HTTP 非 2xx 与响应缺 openid 都按换取失败处理', async () => {
    stubFetch(() => new Response('bad gateway', { status: 502 }))
    try {
      const provider = createLiveWechatIdentityProvider({ appid: APPID, appSecret: APP_SECRET })
      await expect(provider.exchange(CODE)).rejects.toThrow('HTTP 502')
    } finally {
      restore()
    }

    stubFetch(() => new Response(JSON.stringify({ errcode: 0 }), { status: 200 }))
    try {
      const provider = createLiveWechatIdentityProvider({ appid: APPID, appSecret: APP_SECRET })
      await expect(provider.exchange(CODE)).rejects.toThrow('缺少 openid')
    } finally {
      restore()
    }
  })
})
