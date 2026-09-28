import { describe, expect, test } from 'bun:test'
import {
  ACCESS_TOKEN_FAILURE_BACKOFF_MS,
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  createWechatAccessTokenService,
  type WechatAccessTokenService,
  WechatPlatformError,
} from './access-token'

/**
 * 共用微信 `access_token` 服务的边界（#294）。
 *
 * 不验证微信协议本身（那需要真实凭证），只锁住本地能保证的事：
 * 1. `stable_token` 请求体按官方要求拼，且**绝不带 `force_refresh`**（官方限每天 20 次）；
 * 2. 缓存命中不发请求、并发只打一次上游（N 并发 → 1 上游）、到期按「提前 5 分钟」的余量重新取；
 * 3. 失败按阶梯退避、窗口内不打上游，成功即清零；失败**不被当成凭证**缓存、不返回已过期凭证；
 * 4. 网络异常只带错误类型名——异常原文可能含带密钥的 URL（secret 不泄露）；
 * 5. 任何畸形响应（非字符串 / 空 token / 非正 / 溢出 expires_in、非整数 errcode）都 fail closed。
 */
const APPID = 'wxtestappid0000001'
const APP_SECRET = '0123456789abcdef0123456789abcdef'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 替换上游 fetch，记录每次调用的 URL 与 init。 */
function stubFetch(handler: (url: URL, init: RequestInit | undefined) => Response) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input.href : String(input))
    calls.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('createWechatAccessTokenService（stable_token 边界）', () => {
  test('请求体按官方要求拼，带超时信号，且不带 force_refresh', async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonResponse({ access_token: 'tok-1', expires_in: 7200 }),
    )
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    expect(await tokens.get()).toBe('tok-1')

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url.origin).toBe('https://api.weixin.qq.com')
    expect(call?.url.pathname).toBe('/cgi-bin/stable_token')
    expect(call?.init?.method).toBe('POST')
    // 上游挂死不能把请求永远挂着（同 wechat-service 的取舍）。
    expect(call?.init?.signal).toBeDefined()
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>
    expect(body).toEqual({ grant_type: 'client_credential', appid: APPID, secret: APP_SECRET })
    // 官方：force_refresh=true 会使旧 token 失效且每天限用 20 次——生产用它等于自毁。
    expect(body.force_refresh).toBeUndefined()
  })

  test('有效期内复用缓存；并发调用只打一次上游', async () => {
    let upstreamCalls = 0
    const { fetchImpl } = stubFetch(() => {
      upstreamCalls += 1
      return jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    // 三个并发调用共用同一次在途请求（单飞）。
    expect(await Promise.all([tokens.get(), tokens.get(), tokens.get()])).toEqual([
      'tok-1',
      'tok-1',
      'tok-1',
    ])
    expect(upstreamCalls).toBe(1)

    // 缓存命中同样不再打上游。
    expect(await tokens.get()).toBe('tok-1')
    expect(upstreamCalls).toBe(1)
  })

  test('到期按「平台提前 5 分钟换发」的余量重新取', async () => {
    let clock = 1_000_000
    let upstreamCalls = 0
    const { fetchImpl } = stubFetch(() => {
      upstreamCalls += 1
      return jsonResponse({ access_token: `tok-${upstreamCalls}`, expires_in: 3600 })
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
      now: () => clock,
    })

    expect(await tokens.get()).toBe('tok-1')

    // 有效窗口 = 3600s - 5min；差 1ms 到点仍是缓存。
    clock += 3_600_000 - ACCESS_TOKEN_REFRESH_MARGIN_MS - 1
    expect(await tokens.get()).toBe('tok-1')
    expect(upstreamCalls).toBe(1)

    // 越过刷新线后重新取。
    clock += 2
    expect(await tokens.get()).toBe('tok-2')
    expect(upstreamCalls).toBe(2)
  })

  test('上游报错：带 errcode 抛出，且退避窗口内不再打上游', async () => {
    let clock = 1_000_000
    let upstreamCalls = 0
    const { fetchImpl } = stubFetch(() => {
      upstreamCalls += 1
      return jsonResponse({ errcode: 40013, errmsg: 'invalid appid' })
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
      now: () => clock,
    })

    const first = await tokens.get().catch((thrown: unknown) => thrown)
    expect(first).toBeInstanceOf(WechatPlatformError)
    expect((first as WechatPlatformError).errcode).toBe(40013)
    expect(upstreamCalls).toBe(1)

    // 窗口内（差 1ms）快速失败，不再打上游——并发单飞挡不住这种连续重试。
    clock += ACCESS_TOKEN_FAILURE_BACKOFF_MS[0] - 1
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    expect(upstreamCalls).toBe(1)

    // 越过第一档后允许再试。
    clock += 1
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    expect(upstreamCalls).toBe(2)
  })

  test('连续失败按 1s → 2s → 4s → 8s 递增，并封顶在 8s', async () => {
    let clock = 0
    let upstreamCalls = 0
    const { fetchImpl } = stubFetch(() => {
      upstreamCalls += 1
      return jsonResponse({ errcode: 40013, errmsg: 'invalid appid' })
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
      now: () => clock,
    })
    const failAfter = async (offsetMs: number) => {
      clock += offsetMs
      await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    }

    await failAfter(0) // 第 1 次 → 退避 1s
    await failAfter(1000) // 第 2 次 → 退避 2s
    await failAfter(2000) // 第 3 次 → 退避 4s
    await failAfter(4000) // 第 4 次 → 退避 8s
    expect(upstreamCalls).toBe(4)

    // 8s 窗口内（差 1ms）被挡住。
    clock += 7999
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    expect(upstreamCalls).toBe(4)

    // 到点放行；第 5 次失败仍按 8s 封顶（不会继续拉长）。
    await failAfter(1)
    expect(upstreamCalls).toBe(5)
    clock += 7999
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    expect(upstreamCalls).toBe(5)
    await failAfter(1)
    expect(upstreamCalls).toBe(6)
  })

  test('成功一次即清零退避：故障恢复后再失败从第一档重新开始', async () => {
    let clock = 0
    let upstreamCalls = 0
    let mode: 'fail' | 'ok' = 'fail'
    const { fetchImpl } = stubFetch(() => {
      upstreamCalls += 1
      return mode === 'fail'
        ? jsonResponse({ errcode: 40013, errmsg: 'invalid appid' })
        : jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
      now: () => clock,
    })

    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    clock += ACCESS_TOKEN_FAILURE_BACKOFF_MS[0]
    mode = 'ok'
    expect(await tokens.get()).toBe('tok-1')

    // 直接作废缓存再失败一次：若退避没清零，这一刻会被上一个 8s 窗口挡住。
    tokens.invalidate()
    mode = 'fail'
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    expect(upstreamCalls).toBe(3)

    clock += ACCESS_TOKEN_FAILURE_BACKOFF_MS[0] - 1
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    expect(upstreamCalls).toBe(3)
    clock += 1
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    expect(upstreamCalls).toBe(4)
  })

  test('invalidate()：真实缓存被丢弃，下一次重新取', async () => {
    let upstreamCalls = 0
    const { fetchImpl } = stubFetch(() => {
      upstreamCalls += 1
      return jsonResponse({ access_token: `tok-${upstreamCalls}`, expires_in: 7200 })
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    expect(await tokens.get()).toBe('tok-1')
    tokens.invalidate()
    expect(await tokens.get()).toBe('tok-2')
    expect(upstreamCalls).toBe(2)
  })

  test('invalidate(expectedToken)：迟到的旧 token 失效不清掉刚刷新的缓存', async () => {
    let upstreamCalls = 0
    const { fetchImpl } = stubFetch(() => {
      upstreamCalls += 1
      return jsonResponse({ access_token: `tok-${upstreamCalls}`, expires_in: 7200 })
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    expect(await tokens.get()).toBe('tok-1')
    tokens.invalidate('tok-1') // A 的 40001：确实清掉了它用的那个
    expect(await tokens.get()).toBe('tok-2')

    tokens.invalidate('tok-1') // B 迟到的 40001（用的是已被淘汰的旧 token）
    expect(await tokens.get()).toBe('tok-2') // 不该把别人刷新的 T2 一起清掉
    expect(upstreamCalls).toBe(2)
  })

  test('上游 HTTP 500 却带形似成功的 JSON：不能把失败当凭证', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ access_token: 'tok-from-500', expires_in: 7200 }, 500),
    )
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    await expect(tokens.get()).rejects.toThrow('HTTP 500')
  })

  test('上游返回非 JSON：报错而不是把响应当成凭证', async () => {
    const { fetchImpl } = stubFetch(() => new Response('<html>502</html>', { status: 200 }))
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    await expect(tokens.get()).rejects.toThrow('stable_token 响应不是 JSON')
  })

  test('上游挂死：超时后失败，不会永远挂着', async () => {
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    })

    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
  })

  test('上游 errcode 不是整数：fail closed（即使同时给了 access_token），且不进错误信息', async () => {
    // 带 access_token 是关键：若把非整数 errcode 当作「没有错误」，这份畸形响应会被
    // 当成有效凭证缓存下来。
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ errcode: 'super-secret-token', access_token: 'tok', expires_in: 7200 }),
    )
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    const thrown = await tokens.get().catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(WechatPlatformError)
    expect((thrown as Error).message).not.toContain('super-secret-token')
    expect((thrown as Error).message).toContain('errcode 格式非法')
  })

  test('畸形响应不被当成凭证缓存：非字符串 / 空 token、非正 expires_in', async () => {
    for (const body of [
      { access_token: 123, expires_in: 7200 },
      { access_token: '', expires_in: 7200 },
      { access_token: 'tok', expires_in: 0 },
      { access_token: 'tok', expires_in: -1 },
    ]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(body))
      const tokens = createWechatAccessTokenService({
        appid: APPID,
        appSecret: APP_SECRET,
        fetchImpl,
      })
      await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    }
  })

  test('expires_in 溢出成 Infinity：不能算出「永不过期」的凭证', async () => {
    // 必须走原始 JSON 文本：JSON.stringify 会把 Infinity 序列化成 null。
    const { fetchImpl } = stubFetch(
      () =>
        new Response('{"access_token":"tok","expires_in":1e400}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    // 再取一次仍要报错，说明失败没有被当成有效凭证缓存下来。
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
  })

  test('expires_in 有限但荒谬（1e10）：不能算出「永不自然过期」的凭证', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ access_token: 'tok', expires_in: 1e10 }))
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
    await expect(tokens.get()).rejects.toBeInstanceOf(WechatPlatformError)
  })

  test('access_token 前后的空白被去掉后再用', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ access_token: '  tok-trimmed  ', expires_in: 7200 }),
    )
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    expect(await tokens.get()).toBe('tok-trimmed')
  })

  test('网络异常只带错误类型名：异常原文（可能含带密钥的 URL）不进错误信息', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error(
        `connect failed: https://api.weixin.qq.com/cgi-bin/stable_token?secret=${APP_SECRET}`,
      )
    })
    const tokens = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl,
    })

    const thrown = await tokens.get().catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(WechatPlatformError)
    expect((thrown as Error).message).not.toContain(APP_SECRET)
    expect((thrown as Error).message).toContain('Error')
  })
})
