import { describe, expect, test } from 'bun:test'
import {
  createWechatAccessTokenService,
  type WechatAccessTokenService,
  WechatPlatformError,
} from '../wechat/access-token'
import { createWechatMiniappCodeClient } from './wechat-platform'

/**
 * 微信平台侧出码的边界（#197）。
 *
 * 1. 取码成功拿到图片二进制，失败把 JSON 错误体转成带 `errcode` 的异常；
 * 2. `scene` 与 `width` 在本地就按官方边界拦住，`check_path` 随 `env_version` 派生；
 * 3. 上游报凭证失效（40001/42001）时，**真实** token 缓存确实被丢弃；
 * 4. 上游可控文本（errmsg / content-type）不进错误信息。
 */
const APPID = 'wxtestappid0000001'
const APP_SECRET = '0123456789abcdef0123456789abcdef'
const SCENE = 'A'.repeat(22)
const PAGE = 'pages/login-confirm/index'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function imageResponse(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
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

describe('createWechatMiniappCodeClient（getwxacodeunlimit 边界）', () => {
  function fakeTokens(): WechatAccessTokenService & { invalidated: number } {
    const state = {
      invalidated: 0,
      get: async () => 'tok-1',
      invalidate: () => {
        state.invalidated += 1
      },
    }
    return state
  }
  test('上游 errmsg 回显敏感值时，不得进入错误信息', async () => {
    const leaky = `secret=${APP_SECRET}&access_token=leaked-token&scene=${SCENE}`
    const forbidden = [APP_SECRET, 'access_token', SCENE]

    const tokensForTokenCall = createWechatAccessTokenService({
      appid: APPID,
      appSecret: APP_SECRET,
      fetchImpl: stubFetch(() => jsonResponse({ errcode: 40013, errmsg: leaky })).fetchImpl,
    })
    const tokenError = await tokensForTokenCall.get().catch((error: unknown) => error)
    expect(tokenError).toBeInstanceOf(WechatPlatformError)
    for (const secret of forbidden) {
      expect((tokenError as Error).message).not.toContain(secret)
    }

    const codeClient = createWechatMiniappCodeClient({
      tokens: fakeTokens(),
      fetchImpl: stubFetch(() => jsonResponse({ errcode: 40129, errmsg: leaky })).fetchImpl,
    })
    const codeError = await codeClient
      .unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
      .catch((error: unknown) => error)
    expect((codeError as WechatPlatformError).errcode).toBe(40129)
    for (const secret of forbidden) {
      expect((codeError as Error).message).not.toContain(secret)
    }
  })

  test('成功返回图片二进制，check_path 随 env_version 派生', async () => {
    const { calls, fetchImpl } = stubFetch(() => imageResponse([1, 2, 3]))
    const tokens = fakeTokens()
    const client = createWechatMiniappCodeClient({ tokens, fetchImpl })

    const bytes = await client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
    expect(Array.from(bytes)).toEqual([1, 2, 3])

    const first = calls[0]
    expect(first?.url.pathname).toBe('/wxa/getwxacodeunlimit')
    expect(first?.url.searchParams.get('access_token')).toBe('tok-1')
    const releaseBody = JSON.parse(String(first?.init?.body)) as Record<string, unknown>
    expect(releaseBody).toEqual({
      scene: SCENE,
      page: PAGE,
      // 官方默认 true：release 下 page 必须是已发布页面，写错要在这里就被拦住。
      check_path: true,
      env_version: 'release',
    })

    // 未发布版本放行且带宽度，否则发版前根本取不到码。
    await client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'develop', width: 430 })
    const developBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>
    expect(developBody.check_path).toBe(false)
    expect(developBody.env_version).toBe('develop')
    expect(developBody.width).toBe(430)

    // trial 是最常用的发版前联调版本，同样必须放行未发布页面。
    await client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'trial' })
    const trialBody = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>
    expect(trialBody.check_path).toBe(false)
    expect(trialBody.env_version).toBe('trial')
  })

  test('scene 越界或含白名单外字符：本地拦掉，不打上游', async () => {
    const { calls, fetchImpl } = stubFetch(() => imageResponse([1]))
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    for (const scene of ['A'.repeat(33), '', `${'A'.repeat(21)}%`, '中文scene', 'A B']) {
      await expect(client.unlimited({ scene, page: PAGE, envVersion: 'release' })).rejects.toThrow(
        'scene 不合法',
      )
    }
    expect(calls).toHaveLength(0)
  })

  test('scene 精确边界：恰好 32 字符与完整白名单字符集都必须放行', async () => {
    const { calls, fetchImpl } = stubFetch(() => imageResponse([1]))
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    // 官方白名单 `!#$&'()*+,/:;=?@-._~` 一个都不能少，上限也确实是 32 而不是 31。
    const allowedSpecials = "!#$&'()*+,/:;=?@-._~"
    expect(allowedSpecials).toHaveLength(20)
    const fullWidth = allowedSpecials.padEnd(32, 'A')
    expect(fullWidth).toHaveLength(32)

    await client.unlimited({ scene: fullWidth, page: PAGE, envVersion: 'release' })
    await client.unlimited({ scene: 'A'.repeat(32), page: PAGE, envVersion: 'release' })

    // 真实 ticket 是 base64url：数字与小写字母必须放行，否则线上码会被本地校验误拒。
    const base64urlScene = `${'aB3_-0ZxY9'.repeat(2)}qR`
    expect(base64urlScene).toHaveLength(22)
    await client.unlimited({ scene: base64urlScene, page: PAGE, envVersion: 'release' })

    expect(calls).toHaveLength(3)
  })

  test('scene 白名单外的标点：本地拦掉', async () => {
    const { calls, fetchImpl } = stubFetch(() => imageResponse([1]))
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    for (const bad of ['[', ']', '{', '}', '|', '^', '`', '"', '\\']) {
      await expect(
        client.unlimited({ scene: `A${bad}`, page: PAGE, envVersion: 'release' }),
      ).rejects.toThrow('scene 不合法')
    }
    expect(calls).toHaveLength(0)
  })

  test('envVersion / page 在运行时也受门禁（不只靠 TS）', async () => {
    const { calls, fetchImpl } = stubFetch(() => imageResponse([1]))
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    for (const badVersion of ['prod', '', 'RELEASE']) {
      await expect(
        client.unlimited({ scene: SCENE, page: PAGE, envVersion: badVersion as 'release' }),
      ).rejects.toThrow('envVersion')
    }
    for (const badPage of ['', '/pages/login-confirm/index', 'pages/x?a=1', 'pages/x#frag']) {
      await expect(
        client.unlimited({ scene: SCENE, page: badPage, envVersion: 'release' }),
      ).rejects.toThrow('page 不能')
    }
    expect(calls).toHaveLength(0)
  })

  test('width 必须是范围内整数：边界通过，越界 / 小数 / NaN 本地拦掉', async () => {
    const { calls, fetchImpl } = stubFetch(() => imageResponse([1]))
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    // 官方边界本身必须放行。
    await client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release', width: 280 })
    await client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release', width: 1280 })
    expect(calls).toHaveLength(2)

    for (const width of [279, 1281, 280.5, Number.NaN]) {
      await expect(
        client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release', width }),
      ).rejects.toThrow('width 必须是')
    }
    expect(calls).toHaveLength(2)
  })

  test('图片响应：Content-Type 大小写与 charset 参数不影响成功判定', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'Image/JPEG; charset=binary' },
        }),
    )
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    expect(
      Array.from(await client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })),
    ).toEqual([1, 2, 3])
  })

  test('取码上游挂死：超时后失败', async () => {
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const client = createWechatMiniappCodeClient({
      tokens: fakeTokens(),
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    })

    await expect(
      client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' }),
    ).rejects.toBeInstanceOf(WechatPlatformError)
  })

  test('取码错误体的 errcode 不是整数：不进错误信息', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ errcode: 'super-secret-token' }))
    const tokens = fakeTokens()
    const client = createWechatMiniappCodeClient({ tokens, fetchImpl })

    const thrown = await client
      .unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
      .catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(WechatPlatformError)
    expect((thrown as Error).message).not.toContain('super-secret-token')
    expect(tokens.invalidated).toBe(0)
  })

  test('Content-Type 大小写与 charset 参数不影响 JSON 错误识别', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ errcode: 40001, errmsg: 'invalid credential' }), {
          status: 200,
          headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        }),
    )
    const tokens = fakeTokens()
    const client = createWechatMiniappCodeClient({ tokens, fetchImpl })

    const thrown = await client
      .unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
      .catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(WechatPlatformError)
    expect((thrown as WechatPlatformError).errcode).toBe(40001)
    expect(tokens.invalidated).toBe(1)
  })

  test('读取响应体失败：原始异常（可能带 access_token）不进错误信息', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(
          new Error(
            `stream failed: https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${'x'.repeat(32)}`,
          ),
        )
      },
    })
    const { fetchImpl } = stubFetch(
      () => new Response(stream, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    )
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    const thrown = await client
      .unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
      .catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(WechatPlatformError)
    expect((thrown as Error).message).not.toContain('access_token')
    expect((thrown as Error).message).toContain('读取响应失败')
  })

  test('非图片的 2xx 响应不算成功：网关 HTML 错误页 / 缺 Content-Type 的 JSON 都拒绝', async () => {
    const cases = [
      // 网关错误页：既不是图片也解析不出 errcode，只能如实报「未返回图片」。
      {
        name: 'text/html',
        contentType: 'text/html',
        body: '<html>502 Bad Gateway</html>',
        errcode: undefined,
        invalidated: 0,
      },
      // 缺 Content-Type 但 body 是微信错误体：按失败处理，并丢掉死 token。
      {
        name: '缺 content-type',
        contentType: null,
        body: '{"errcode":40001,"errmsg":"invalid credential"}',
        errcode: 40001,
        invalidated: 1,
      },
    ] as const

    for (const item of cases) {
      const { calls, fetchImpl } = stubFetch(
        () =>
          new Response(item.body, {
            status: 200,
            ...(item.contentType === null ? {} : { headers: { 'content-type': item.contentType } }),
          }),
      )
      const tokens = fakeTokens()
      const client = createWechatMiniappCodeClient({ tokens, fetchImpl })

      const thrown = await client
        .unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
        .catch((error: unknown) => error)
      expect(thrown, item.name).toBeInstanceOf(WechatPlatformError)
      expect((thrown as WechatPlatformError).errcode, item.name).toBe(item.errcode)
      expect(tokens.invalidated, item.name).toBe(item.invalidated)
      expect(calls, item.name).toHaveLength(1)
    }
  })

  test('HTTP 500 却带 image/jpeg：不能当成二维码返回', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 500,
          headers: { 'content-type': 'image/jpeg' },
        }),
    )
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    await expect(
      client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' }),
    ).rejects.toThrow('HTTP 500')
  })

  test('2xx 却是空图片体：不算取码成功', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(new Uint8Array([]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    )
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    await expect(
      client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' }),
    ).rejects.toThrow('空图片')
  })

  test('错误体被标成 text/plain 也不当成图片：仍然丢掉死 token', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response('{"errcode":40001,"errmsg":"invalid credential"}', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    )
    const tokens = fakeTokens()
    const client = createWechatMiniappCodeClient({ tokens, fetchImpl })

    const thrown = await client
      .unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
      .catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(WechatPlatformError)
    expect((thrown as WechatPlatformError).errcode).toBe(40001)
    expect(tokens.invalidated).toBe(1)
  })

  test('失败返回 JSON：转成带 errcode 的异常', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ errcode: 40129, errmsg: 'invalid scene' }))
    const client = createWechatMiniappCodeClient({ tokens: fakeTokens(), fetchImpl })

    const thrown = await client
      .unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' })
      .catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(WechatPlatformError)
    expect((thrown as WechatPlatformError).errcode).toBe(40129)
  })

  for (const errcode of [40001, 40014, 42001]) {
    test(`取码报 ${errcode}（凭证失效）：真实 token 缓存被丢弃，下一次重新取`, async () => {
      let tokenCalls = 0
      const fetchImpl = (async (input: unknown) => {
        const url = new URL(input instanceof URL ? input.href : String(input))
        if (url.pathname === '/cgi-bin/stable_token') {
          tokenCalls += 1
          return jsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 7200 })
        }
        return jsonResponse({ errcode, errmsg: 'invalid credential' })
      }) as unknown as typeof fetch

      const tokens = createWechatAccessTokenService({
        appid: APPID,
        appSecret: APP_SECRET,
        fetchImpl,
      })
      const client = createWechatMiniappCodeClient({ tokens, fetchImpl })

      expect(await tokens.get()).toBe('tok-1')
      await expect(
        client.unlimited({ scene: SCENE, page: PAGE, envVersion: 'release' }),
      ).rejects.toBeInstanceOf(WechatPlatformError)
      // 死 token 必须被丢掉；否则会一路重试到 expiresAt。
      expect(await tokens.get()).toBe('tok-2')
    })
  }
})
