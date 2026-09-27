import { describe, expect, test } from 'bun:test'
import {
  createWechatAccessTokenProvider,
  WECHAT_TOKEN_SAFETY_MARGIN_MS,
  WECHAT_TOKEN_TIMEOUT_MS,
  WechatAccessTokenError,
} from './access-token'

/**
 * 共用 access_token 服务的本地边界（#294）。
 *
 * 真实凭证与微信上游无法在 CI 覆盖，所以这里用全局 fetch 打桩，只锁住本地能保证的语义：
 * 1. 请求按 `client_credential` 拼参、带超时信号；
 * 2. 缓存命中不再打上游、提前过期、过期刷新；
 * 3. 并发去重：同一时刻 N 个调用只发一次上游请求；
 * 4. 失败抛类型化错误、**不缓存失败结果**，且错误信息不含 AppSecret / 完整 URL。
 */
const APPID = 'wxtestappid0000001'
const APP_SECRET = '0123456789abcdef0123456789abcdef'

function tokenResponse(token: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
  })
}

describe('createWechatAccessTokenProvider（access_token 缓存 / 去重 / 失败语义）', () => {
  const originalFetch = globalThis.fetch

  /** 替换全局 fetch：记录每次调用，由 handler 产出响应（可抛错模拟网络失败）。 */
  function stubFetch(
    handler: (
      url: URL,
      init: RequestInit | undefined,
      callIndex: number,
    ) => Response | Promise<Response>,
  ) {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(input instanceof URL ? input.href : String(input))
      calls.push({ url, init })
      return handler(url, init, calls.length - 1)
    }) as unknown as typeof fetch
    return calls
  }

  function restore() {
    globalThis.fetch = originalFetch
  }

  test('请求参数按 client_credential 拼，返回 access_token，并带超时信号', async () => {
    const calls = stubFetch(() => tokenResponse('TOKEN-1', 7200))
    try {
      const provider = createWechatAccessTokenProvider({ appid: APPID, appSecret: APP_SECRET })

      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      expect(calls).toHaveLength(1)
      const call = calls[0]
      expect(call?.url.origin).toBe('https://api.weixin.qq.com')
      expect(call?.url.pathname).toBe('/cgi-bin/token')
      expect(call?.url.searchParams.get('grant_type')).toBe('client_credential')
      expect(call?.url.searchParams.get('appid')).toBe(APPID)
      expect(call?.url.searchParams.get('secret')).toBe(APP_SECRET)
      // 上游挂死不能把这次调用永远挂着
      expect(call?.init?.signal).toBeInstanceOf(AbortSignal)
      expect(WECHAT_TOKEN_TIMEOUT_MS).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test('缓存命中：有效期内重复调用不再请求上游', async () => {
    let nowMs = 1_000_000
    const calls = stubFetch(() => tokenResponse('TOKEN-1', 7200))
    try {
      const provider = createWechatAccessTokenProvider({
        appid: APPID,
        appSecret: APP_SECRET,
        now: () => nowMs,
      })

      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      nowMs += 60_000
      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      expect(calls).toHaveLength(1)
    } finally {
      restore()
    }
  })

  test('提前过期：进入安全余量窗口即刷新，余量窗口前不刷新', async () => {
    let nowMs = 0
    const calls = stubFetch((_url, _init, callIndex) =>
      tokenResponse(`TOKEN-${callIndex + 1}`, 7200),
    )
    try {
      const provider = createWechatAccessTokenProvider({
        appid: APPID,
        appSecret: APP_SECRET,
        now: () => nowMs,
      })

      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      // 距真正过期还有「安全余量 + 1ms」：仍在有效期内，不该刷新
      nowMs = 7200_000 - WECHAT_TOKEN_SAFETY_MARGIN_MS - 1
      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      expect(calls).toHaveLength(1)

      // 进入安全余量：expires_in 还没走完也要刷新，绝不把已过期 token 发出去
      nowMs += 2
      expect(await provider.getAccessToken()).toBe('TOKEN-2')
      expect(calls).toHaveLength(2)
    } finally {
      restore()
    }
  })

  test('expires_in 比安全余量还短时：不返回「出生即过期」的 token', async () => {
    let nowMs = 0
    const calls = stubFetch((_url, _init, callIndex) => tokenResponse(`TOKEN-${callIndex + 1}`, 60))
    try {
      const provider = createWechatAccessTokenProvider({
        appid: APPID,
        appSecret: APP_SECRET,
        now: () => nowMs,
        safetyMarginMs: 300_000,
      })

      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      // 余量盖过整个 ttl 时回落为全额 ttl：59s 内仍在有效期内，可命中缓存
      nowMs += 59_000
      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      expect(calls).toHaveLength(1)

      nowMs += 2_000
      expect(await provider.getAccessToken()).toBe('TOKEN-2')
      expect(calls).toHaveLength(2)
    } finally {
      restore()
    }
  })

  test('并发去重：同一时刻 5 个并发调用只发一次上游请求', async () => {
    let releaseUpstream: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve
    })
    const calls = stubFetch(async () => {
      await gate
      return tokenResponse('TOKEN-1', 7200)
    })
    try {
      const provider = createWechatAccessTokenProvider({ appid: APPID, appSecret: APP_SECRET })
      const pending = Promise.all(Array.from({ length: 5 }, () => provider.getAccessToken()))
      await Bun.sleep(0)
      expect(calls).toHaveLength(1)

      releaseUpstream?.()
      expect(await pending).toEqual(['TOKEN-1', 'TOKEN-1', 'TOKEN-1', 'TOKEN-1', 'TOKEN-1'])
      expect(calls).toHaveLength(1)

      // 请求收尾后仍走缓存，不会再打一次上游
      expect(await provider.getAccessToken()).toBe('TOKEN-1')
      expect(calls).toHaveLength(1)
    } finally {
      restore()
    }
  })

  test('上游 errcode 非 0 → 类型化错误，且失败结果不进缓存', async () => {
    const calls = stubFetch((_url, _init, callIndex) =>
      callIndex === 0
        ? new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid appid' }), { status: 200 })
        : tokenResponse('TOKEN-2', 7200),
    )
    try {
      const provider = createWechatAccessTokenProvider({ appid: APPID, appSecret: APP_SECRET })

      let caught: unknown
      try {
        await provider.getAccessToken()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(WechatAccessTokenError)
      expect(String(caught)).toContain('errcode=40013')
      expect((caught as WechatAccessTokenError).failure).toBe('upstream')

      // 失败不缓存：下一次调用重新请求并成功
      expect(await provider.getAccessToken()).toBe('TOKEN-2')
      expect(calls).toHaveLength(2)
    } finally {
      restore()
    }
  })

  test('网络失败 → 类型化错误，且不泄露 AppSecret 与完整 URL', async () => {
    stubFetch(() => {
      const error = new Error(
        `fetch failed for https://api.weixin.qq.com/cgi-bin/token?secret=${APP_SECRET}`,
      )
      error.name = 'TimeoutError'
      throw error
    })
    try {
      const provider = createWechatAccessTokenProvider({ appid: APPID, appSecret: APP_SECRET })

      let caught: unknown
      try {
        await provider.getAccessToken()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(WechatAccessTokenError)
      // 只带错误类型名：原文可能含带 secret 的 URL，绝不透出去
      expect(String(caught)).toContain('TimeoutError')
      expect(String(caught)).not.toContain(APP_SECRET)
      expect(String(caught)).not.toContain('api.weixin.qq.com')
      expect((caught as WechatAccessTokenError).failure).toBe('network')
    } finally {
      restore()
    }
  })

  test('并发等待者共享同一次失败，失败后下一次调用重新请求', async () => {
    let firstCall = true
    const calls = stubFetch(async () => {
      if (firstCall) {
        firstCall = false
        const error = new Error('socket closed')
        error.name = 'TypeError'
        throw error
      }
      return tokenResponse('TOKEN-2', 7200)
    })
    try {
      const provider = createWechatAccessTokenProvider({ appid: APPID, appSecret: APP_SECRET })

      const results = await Promise.allSettled([
        provider.getAccessToken(),
        provider.getAccessToken(),
        provider.getAccessToken(),
      ])
      expect(calls).toHaveLength(1)
      for (const result of results) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(WechatAccessTokenError)
        }
      }

      expect(await provider.getAccessToken()).toBe('TOKEN-2')
      expect(calls).toHaveLength(2)
    } finally {
      restore()
    }
  })

  test('刷新飞行途中缓存到期：后来者仍共享这次刷新，不另起上游请求', async () => {
    let nowMs = 0
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    // 首个 token 的 expires_in 只有 1s（余量盖过 ttl → 全额 ttl），让缓存在刷新飞行途中就过期
    const calls = stubFetch(async (_url, _init, callIndex) => {
      if (callIndex === 0) return tokenResponse('TOKEN-1', 1)
      await refreshGate
      return tokenResponse('TOKEN-2', 1)
    })
    try {
      const provider = createWechatAccessTokenProvider({
        appid: APPID,
        appSecret: APP_SECRET,
        now: () => nowMs,
      })

      expect(await provider.getAccessToken()).toBe('TOKEN-1')

      // 缓存已过期 → 发起刷新；这次上游请求故意挂住不返回
      nowMs = 1_001
      const refresh = provider.getAccessToken()
      await Bun.sleep(0)
      expect(calls).toHaveLength(2)

      // 「缓存过期」与「刷新在飞」同时成立：后来者不能再打一次上游，总数仍是一次首次获取 + 一次刷新
      nowMs = 3_000
      const joined = provider.getAccessToken()
      await Bun.sleep(0)
      expect(calls).toHaveLength(2)

      releaseRefresh?.()
      expect(await refresh).toBe('TOKEN-2')
      expect(await joined).toBe('TOKEN-2')
      expect(calls).toHaveLength(2)
    } finally {
      restore()
    }
  })

  test('HTTP 非 2xx 与响应缺 access_token 都按类型化错误处理', async () => {
    stubFetch(() => new Response('bad gateway', { status: 502 }))
    try {
      const provider = createWechatAccessTokenProvider({ appid: APPID, appSecret: APP_SECRET })
      await expect(provider.getAccessToken()).rejects.toThrow('HTTP 502')
    } finally {
      restore()
    }

    stubFetch(() => new Response(JSON.stringify({ errcode: 0 }), { status: 200 }))
    try {
      const provider = createWechatAccessTokenProvider({ appid: APPID, appSecret: APP_SECRET })
      await expect(provider.getAccessToken()).rejects.toThrow('缺少 access_token')
    } finally {
      restore()
    }
  })
})
