import { afterEach, describe, expect, mock, test } from 'bun:test'
import { CampusEmailSchema } from '@fish/contracts/auth/verification'
import { ApiError } from '../../lib/api-client'
import {
  CAMPUS_EMAIL_REQUIREMENT,
  fetchVerificationStatus,
  isCampusEmail,
  sendVerificationCode,
  verifyCampusCode,
} from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

type Call = { url: string; method: string; body: string | null }

function stubFetch(respond: () => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return respond()
    // Bun 的 `fetch` 类型带 `preconnect` 等静态属性，`mock()` 造不出，按仓内惯例收口。
  }) as unknown as typeof fetch
  return calls
}

/** 未认证的权威状态：三个端点的响应同构，只是这里不关心具体内容。 */
function unverifiedBody() {
  return { authStatus: 'UNVERIFIED', verifiedAt: null, maskedEmail: null }
}

describe('isCampusEmail', () => {
  test('接受精确域；大小写与尾随空格在端上先归一', () => {
    expect(isCampusEmail('zhangsan@gzasc.edu.cn')).toBe(true)
    expect(isCampusEmail('ZhangSan@GZASC.EDU.CN')).toBe(true)
    // 契约的 `.email()` 先于 `.trim()` 生效，原始值带尾空格会被 schema 拒掉，
    // 所以 API 入口必须先 trim —— 这条用例就是钉住那次 trim。
    expect(isCampusEmail('zhangsan@gzasc.edu.cn ')).toBe(true)
    expect(isCampusEmail('  zhangsan@gzasc.edu.cn  ')).toBe(true)
  })

  test('提交前拦下子域 / 双 @ / 含空格 / 非白名单域，不给服务端 422·500 的机会', () => {
    for (const bad of [
      'zhangsan@school.gzasc.edu.cn',
      'zhangsan@@gzasc.edu.cn',
      'zhang san@gzasc.edu.cn',
      'zhangsan@gmail.com',
      'zhangsan@gzasc.edu.com',
      'zhangsan@gzasc.edu.cn.evil.com',
      '@gzasc.edu.cn',
      '',
    ]) {
      expect(isCampusEmail(bad)).toBe(false)
    }
  })

  test('域名提示文案与契约 refine 的 message 逐字一致（服务端 422 的 details 也是它）', () => {
    const parsed = CampusEmailSchema.safeParse('someone@example.com')
    if (parsed.success) throw new Error('契约应当拒绝非白名单域')
    expect(CAMPUS_EMAIL_REQUIREMENT).toBe(parsed.error.issues[0]?.message ?? '')
  })
})

describe('校园认证三个端点', () => {
  test('发码 POST /auth/verification/code，body 是归一后的邮箱', async () => {
    const calls = stubFetch(() => Response.json({ sent: true }))

    await sendVerificationCode('  ZhangSan@GZASC.EDU.CN  ')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/auth/verification/code')
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({ email: 'zhangsan@gzasc.edu.cn' })
  })

  test('发码只接受「已受理」，响应形状漂移会在进 UI 前暴露', async () => {
    stubFetch(() => Response.json({ sent: 'yes' }))
    await expect(sendVerificationCode('zhangsan@gzasc.edu.cn')).rejects.toThrow()
  })

  test('校验 POST /auth/verification/verify 并返回权威状态（含脱敏邮箱）', async () => {
    const calls = stubFetch(() =>
      Response.json({
        authStatus: 'VERIFIED',
        verifiedAt: '2026-10-01T02:03:04.000Z',
        maskedEmail: 'z***@gzasc.edu.cn',
      }),
    )

    const status = await verifyCampusCode('zhangsan@gzasc.edu.cn', '123456')

    expect(calls[0]?.url).toBe('/api/auth/verification/verify')
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      email: 'zhangsan@gzasc.edu.cn',
      code: '123456',
    })
    expect(status).toEqual({
      authStatus: 'VERIFIED',
      verifiedAt: '2026-10-01T02:03:04.000Z',
      maskedEmail: 'z***@gzasc.edu.cn',
    })
  })

  test('校验失败抛 ApiError 且不吞错误码（文案由展示层按码决定）', async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: 'CODE_CONSUMED', message: '验证码已被使用，请重新获取' } },
        { status: 409 },
      ),
    )

    try {
      await verifyCampusCode('zhangsan@gzasc.edu.cn', '123456')
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe('CODE_CONSUMED')
      expect((error as ApiError).status).toBe(409)
    }
  })

  test('状态 GET /auth/verification/status 解析脱敏邮箱', async () => {
    const calls = stubFetch(() =>
      Response.json({
        authStatus: 'VERIFIED',
        verifiedAt: '2026-10-01T02:03:04.000Z',
        maskedEmail: 'z***@gzasc.edu.cn',
      }),
    )

    expect(await fetchVerificationStatus()).toEqual({
      authStatus: 'VERIFIED',
      verifiedAt: '2026-10-01T02:03:04.000Z',
      maskedEmail: 'z***@gzasc.edu.cn',
    })
    expect(calls[0]?.url).toBe('/api/auth/verification/status')
    expect(calls[0]?.method).toBe('GET')
  })

  test('状态响应里出现明文邮箱字段也不会被端上读出来（契约只认 maskedEmail）', async () => {
    stubFetch(() =>
      Response.json({
        ...unverifiedBody(),
        authStatus: 'VERIFIED',
        // 契约是 z.object（非 strictObject）：多出来的字段会被丢弃，不进 UI。
        email: 'zhangsan@gzasc.edu.cn',
        maskedEmail: 'z***@gzasc.edu.cn',
      }),
    )

    const status = await fetchVerificationStatus()
    expect(status.maskedEmail).toBe('z***@gzasc.edu.cn')
    expect(Object.keys(status)).toEqual(['authStatus', 'verifiedAt', 'maskedEmail'])
  })
})
